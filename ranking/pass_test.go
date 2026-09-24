package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A fake Shopify: hands out a token, answers the two reports, records writes.
func fakeShopify(t *testing.T, salesFails bool) (*httptest.Server, *[]metafield) {
	var written []metafield
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin/oauth/access_token" {
			r.ParseForm()
			if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_secret") != "s3cret" {
				http.Error(w, "no", 400)
				return
			}
			fmt.Fprint(w, `{"access_token":"tok","expires_in":86399,"scope":"read_reports,write_products"}`)
			return
		}
		if r.Header.Get("X-Shopify-Access-Token") != "tok" {
			http.Error(w, "unauthorized", 401)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Query     string          `json:"query"`
			Variables json.RawMessage `json:"variables"`
		}
		json.Unmarshal(raw, &req)
		switch {
		case strings.Contains(req.Query, "shopifyqlQuery"):
			var v struct{ Q string }
			json.Unmarshal(req.Variables, &v)
			switch {
			case strings.Contains(v.Q, "OFFSET 1000"):
				fmt.Fprint(w, `{"data":{"shopifyqlQuery":{"tableData":{"columns":[],"rows":[]},"parseErrors":[]}}}`)
			case strings.HasPrefix(v.Q, "FROM sales") && salesFails:
				fmt.Fprint(w, `{"errors":[{"message":"Access denied for shopifyqlQuery field."}]}`)
			case strings.HasPrefix(v.Q, "FROM sales"):
				fmt.Fprint(w, `{"data":{"shopifyqlQuery":{"tableData":{"columns":[{"name":"product_id"},{"name":"net_items_sold"},{"name":"orders"},{"name":"returned_quantity_rate"}],
					"rows":[{"product_id":"8000000001","net_items_sold":"40","orders":"35","returned_quantity_rate":"2.5"},{"product_id":null,"net_items_sold":"3"}]},"parseErrors":[]}}}`)
			default: // recommendations
				fmt.Fprint(w, `{"data":{"shopifyqlQuery":{"tableData":{"columns":[{"name":"product_id"},{"name":"sessions_with_product_recommendations"}],
					"rows":[["8000000002", 900]]},"parseErrors":[]}}}`)
			}
		case strings.Contains(req.Query, "metafieldsSet"):
			var v struct{ M []metafield }
			json.Unmarshal(req.Variables, &v)
			written = append(written, v.M...)
			fmt.Fprint(w, `{"data":{"metafieldsSet":{"userErrors":[]}},"extensions":{"cost":{"throttleStatus":{"currentlyAvailable":1900,"restoreRate":100}}}}`)
		default:
			http.Error(w, "unexpected query", 400)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &written
}

func testEngine(t *testing.T, srv *httptest.Server) *Engine {
	shop := &Shop{Domain: strings.TrimPrefix(srv.URL, "https://"), ClientID: "id", Secret: "s3cret", hc: srv.Client()}
	e := &Engine{Shop: shop, Counts: newCounts(), Dir: t.TempDir()}
	e.load()
	return e
}

func TestPassWritesOnlyChanges(t *testing.T) {
	srv, written := fakeShopify(t, false)
	e := testEngine(t, srv)
	e.Counts.add(time.Now(), kView, []uint64{8000000003})
	quiet := func(string, ...any) {}

	if err := e.Pass(context.Background(), true, quiet); err != nil || len(*written) != 0 {
		t.Fatalf("dry run must not write: err=%v writes=%d", err, len(*written))
	}
	if err := e.Pass(context.Background(), false, quiet); err != nil {
		t.Fatal(err)
	}
	if len(*written) != 9 { // 3 products (sales, recommendations, pixel) x 3 metafields
		t.Fatalf("first pass wrote %d metafields", len(*written))
	}
	got := map[string]string{}
	for _, m := range *written {
		got[m.OwnerID+" "+m.Namespace+"."+m.Key] = m.Value
	}
	if got["gid://shopify/Product/8000000001 custom.units_sold_30d"] != "40" {
		t.Fatalf("units not written: %v", got)
	}

	*written = nil
	if err := e.Pass(context.Background(), false, quiet); err != nil || len(*written) != 0 {
		t.Fatalf("unchanged week must write nothing: err=%v writes=%d", err, len(*written))
	}

	// Reload from disk, as after a restart: still nothing to write.
	e2 := testEngine(t, srv)
	e2.Dir = e.Dir
	e2.Counts = e.Counts
	e2.load()
	if err := e2.Pass(context.Background(), false, quiet); err != nil || len(*written) != 0 {
		t.Fatalf("after restart: err=%v writes=%d", err, len(*written))
	}
}

func TestPassRefusesWithoutSales(t *testing.T) {
	srv, written := fakeShopify(t, true)
	e := testEngine(t, srv)
	err := e.Pass(context.Background(), false, func(string, ...any) {})
	if err == nil || len(*written) != 0 {
		t.Fatalf("a failed sales report must write nothing: err=%v writes=%d", err, len(*written))
	}
}
