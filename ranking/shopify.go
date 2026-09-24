package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const apiVersion = "2026-07" // same as the Size Charts app (server/utils/shopify.ts)

// Shop talks to the Admin API as the Tudoholic Ranking app. The token comes
// from the client credentials grant (the app and the store are in the same
// Shopify organization), lives 24 h, and is never stored on disk.
type Shop struct {
	Domain, ClientID, Secret string

	token   string
	expires time.Time
	hc      *http.Client
}

func (s *Shop) auth(ctx context.Context) error {
	if s.token != "" && time.Now().Before(s.expires) {
		return nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {s.ClientID}, "client_secret": {s.Secret}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+s.Domain+"/admin/oauth/access_token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var body struct {
		Token     string `json:"access_token"`
		ExpiresIn int    `json:"expires_in"`
		Scope     string `json:"scope"`
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK || json.Unmarshal(raw, &body) != nil || body.Token == "" {
		msg := string(raw)
		// Shopify answers a bad client id with an HTML page; its <title> is the reason.
		if a, b := strings.Index(msg, "<title>"), strings.Index(msg, "</title>"); a >= 0 && b > a {
			msg = msg[a+7 : b]
		}
		return fmt.Errorf("token request refused (%d): %.200s", res.StatusCode, msg)
	}
	s.token = body.Token
	s.expires = time.Now().Add(time.Duration(body.ExpiresIn-300) * time.Second)
	logf("shopify: token ok, scopes %s", body.Scope)
	return nil
}

// gql runs one Admin GraphQL call and waits out Shopify's rate limit so the
// next call never gets refused.
func (s *Shop) gql(ctx context.Context, query string, vars map[string]any, out any) error {
	for attempt := 0; attempt < 6; attempt++ {
		if err := s.auth(ctx); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]any{"query": query, "variables": vars})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+s.Domain+"/admin/api/"+apiVersion+"/graphql.json", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Shopify-Access-Token", s.token)
		res, err := s.hc.Do(req)
		if err != nil {
			return err
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<20))
		res.Body.Close()
		if res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500 {
			time.Sleep(time.Duration(2<<attempt) * time.Second)
			continue
		}
		var env struct {
			Data   json.RawMessage `json:"data"`
			Errors []struct {
				Message    string `json:"message"`
				Extensions struct {
					Code string `json:"code"`
				} `json:"extensions"`
			} `json:"errors"`
			Extensions struct {
				Cost struct {
					Throttle struct {
						Available float64 `json:"currentlyAvailable"`
						Restore   float64 `json:"restoreRate"`
					} `json:"throttleStatus"`
				} `json:"cost"`
			} `json:"extensions"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("admin api %d: %.200s", res.StatusCode, raw)
		}
		if len(env.Errors) > 0 {
			if env.Errors[0].Extensions.Code == "THROTTLED" {
				time.Sleep(2 * time.Second)
				continue
			}
			return fmt.Errorf("admin api: %s", env.Errors[0].Message)
		}
		if t := env.Extensions.Cost.Throttle; t.Restore > 0 && t.Available < 200 {
			time.Sleep(time.Duration((200 - t.Available) / t.Restore * float64(time.Second)))
		}
		return json.Unmarshal(env.Data, out)
	}
	return fmt.Errorf("admin api: still throttled after retries")
}

// shopifyQL runs a ShopifyQL report and pages through it 1000 rows at a time.
// Rows come back keyed by column name.
func (s *Shop) shopifyQL(ctx context.Context, base string, each func(row map[string]any)) (int, error) {
	const page = 1000
	total := 0
	for offset := 0; offset < 500_000; offset += page {
		var out struct {
			Q struct {
				Table struct {
					Columns []struct {
						Name string `json:"name"`
					} `json:"columns"`
					Rows json.RawMessage `json:"rows"`
				} `json:"tableData"`
				ParseErrors json.RawMessage `json:"parseErrors"`
			} `json:"shopifyqlQuery"`
		}
		q := fmt.Sprintf("%s LIMIT %d OFFSET %d", base, page, offset)
		err := s.gql(ctx, `query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }`, map[string]any{"q": q}, &out)
		if err != nil {
			return total, err
		}
		if pe := strings.TrimSpace(string(out.Q.ParseErrors)); pe != "" && pe != "null" && pe != "[]" {
			return total, fmt.Errorf("shopifyql: %s", pe)
		}
		rows := decodeRows(out.Q.Table.Rows, out.Q.Table.Columns)
		for _, r := range rows {
			each(r)
		}
		total += len(rows)
		if len(rows) < page {
			break
		}
	}
	return total, nil
}

// decodeRows accepts rows as objects ({"product_id": …}) or as arrays in
// column order; the API has returned both shapes over its versions.
func decodeRows(raw json.RawMessage, cols []struct {
	Name string `json:"name"`
}) []map[string]any {
	dec := func(v any) error {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		return d.Decode(v)
	}
	var objs []map[string]any
	if dec(&objs) == nil {
		return objs
	}
	var arrs [][]any
	if dec(&arrs) != nil {
		return nil
	}
	out := make([]map[string]any, 0, len(arrs))
	for _, a := range arrs {
		m := make(map[string]any, len(a))
		for i, v := range a {
			if i < len(cols) {
				m[cols[i].Name] = v
			}
		}
		out = append(out, m)
	}
	return out
}

func num(v any) float64 {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case float64:
		return x
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSuffix(x, "%"), 64)
		return f
	}
	return 0
}

func rowID(v any) (uint64, bool) {
	switch x := v.(type) {
	case json.Number:
		return parseID(x.String())
	case string:
		return parseID(x)
	}
	return 0, false
}

// setMetafields writes 24 metafields per call: the API allows 25, and 24 keeps
// each product's three metafields in the same call.
type metafield struct {
	OwnerID   string `json:"ownerId"`
	Namespace string `json:"namespace"`
	Key       string `json:"key"`
	Type      string `json:"type"`
	Value     string `json:"value"`
}

func (s *Shop) setMetafields(ctx context.Context, all []metafield) (failed int, err error) {
	for i := 0; i < len(all); i += 24 {
		batch := all[i:min(i+24, len(all))]
		var out struct {
			Set struct {
				UserErrors []struct {
					Message string `json:"message"`
				} `json:"userErrors"`
			} `json:"metafieldsSet"`
		}
		if err := s.gql(ctx, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, map[string]any{"m": batch}, &out); err != nil {
			return failed, err
		}
		if n := len(out.Set.UserErrors); n > 0 {
			// Usually a product deleted since the report ran. The whole batch
			// is refused, so retry its products one at a time.
			if len(batch) > 3 {
				for j := 0; j < len(batch); j += 3 {
					f, err := s.setMetafields(ctx, batch[j:min(j+3, len(batch))])
					failed += f
					if err != nil {
						return failed, err
					}
				}
				continue
			}
			failed++
			logf("metafields: %s refused: %s", batch[0].OwnerID, out.Set.UserErrors[0].Message)
		}
	}
	return failed, nil
}
