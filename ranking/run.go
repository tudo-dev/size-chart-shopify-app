package main

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"
)

// The two Shopify reports the engine reads. Sales is required: without it
// every product's units would reset to 0. The recommendation funnel is a
// bonus; if Shopify refuses it the pass carries on without it.
const (
	salesQuery = `FROM sales SHOW net_items_sold, orders, returned_quantity_rate GROUP BY product_id SINCE -30d UNTIL today ORDER BY net_items_sold DESC`
	recsQuery  = `FROM product_recommendation_conversions SHOW sessions_with_product_recommendations, product_recommendation_sessions_with_clicks, product_recommendation_sessions_with_cart_additions, product_recommendation_sessions_that_completed_checkout GROUP BY product_id SINCE -28d UNTIL today ORDER BY sessions_with_product_recommendations DESC`
)

// What the theme reads (sections/main-collection-popular-products.liquid).
// custom.units_sold_30d predates this engine: snippets/card-product.liquid
// already reads it for the best-selling fallback.
var (
	mfScore = [2]string{"tudo", "rank_score"}
	mfHide  = [2]string{"tudo", "rail_hide"}
	mfUnits = [2]string{"custom", "units_sold_30d"}
)

type Written struct {
	At      time.Time
	Product map[uint64]Result
}

type Engine struct {
	Shop    *Shop
	Counts  *Counts
	Dir     string
	written Written
}

func (e *Engine) writtenPath() string { return e.Dir + "/written.gob" }

func (e *Engine) load() {
	if err := readGob(e.writtenPath(), &e.written); err != nil {
		e.written = Written{}
	}
	if e.written.Product == nil {
		e.written.Product = map[uint64]Result{}
	}
}

// Pass gathers Shopify's reports and the pixel's counters, scores every
// product, and writes only the metafields whose value changed.
func (e *Engine) Pass(ctx context.Context, dry bool, say func(string, ...any)) error {
	start := time.Now()
	sig := e.Counts.totals(start)
	say("pixel: %d products with storefront activity in the last 4 weeks", len(sig))
	get := func(id uint64) *Signals {
		if sig[id] == nil {
			sig[id] = &Signals{}
		}
		return sig[id]
	}

	n, err := e.Shop.shopifyQL(ctx, salesQuery, func(r map[string]any) {
		id, ok := rowID(r["product_id"])
		if !ok {
			return
		}
		s := get(id)
		s.Units = math.Max(0, num(r["net_items_sold"]))
		s.Orders = math.Max(0, num(r["orders"]))
		rr := num(r["returned_quantity_rate"])
		if rr > 1 {
			rr /= 100 // reported as a percentage
		}
		s.Returned = rr
	})
	if err != nil {
		return fmt.Errorf("sales report failed, nothing written: %w", err)
	}
	say("shopify sales: %d products sold in the last 30 days", n)

	n, err = e.Shop.shopifyQL(ctx, recsQuery, func(r map[string]any) {
		id, ok := rowID(r["product_id"])
		if !ok {
			return
		}
		s := get(id)
		s.Impr += num(r["sessions_with_product_recommendations"])
		s.Views = math.Max(s.Views, num(r["product_recommendation_sessions_with_clicks"]))
		s.Carts = math.Max(s.Carts, num(r["product_recommendation_sessions_with_cart_additions"]))
		s.Orders = math.Max(s.Orders, num(r["product_recommendation_sessions_that_completed_checkout"]))
	})
	if err != nil {
		say("shopify recommendations report skipped: %v", err)
	} else {
		say("shopify recommendations: %d products", n)
	}

	results := Rank(sig)

	// Only what changed, plus products that had values and now have none.
	var mfs []metafield
	changed, cleared, hidden := 0, 0, 0
	add := func(id uint64, r Result) {
		gid := "gid://shopify/Product/" + strconv.FormatUint(id, 10)
		mfs = append(mfs,
			metafield{gid, mfScore[0], mfScore[1], "number_integer", strconv.Itoa(int(r.Score))},
			metafield{gid, mfHide[0], mfHide[1], "boolean", strconv.FormatBool(r.Hide)},
			metafield{gid, mfUnits[0], mfUnits[1], "number_integer", strconv.Itoa(int(r.Units))},
		)
	}
	for id, r := range results {
		if r.Hide {
			hidden++
		}
		if old, ok := e.written.Product[id]; !ok || old != r {
			add(id, r)
			changed++
		}
	}
	for id, old := range e.written.Product {
		if _, ok := results[id]; !ok && old != (Result{}) {
			add(id, Result{})
			cleared++
		}
	}
	say("ranked %d products: %d hidden from rails, %d to update, %d to clear", len(results), hidden, changed, cleared)
	logTop(results, say)

	// A report that suddenly lost most of the store is a Shopify hiccup, not
	// a real week: refuse rather than wipe the rails.
	if prev := len(e.written.Product); prev > 200 && cleared > prev/2 {
		return fmt.Errorf("would clear %d of %d ranked products; refusing, nothing written", cleared, prev)
	}
	if dry {
		say("dry run: nothing written")
		return nil
	}

	failed, err := e.Shop.setMetafields(ctx, mfs)
	if err != nil {
		return fmt.Errorf("writing stopped part-way (%d refused so far): %w", failed, err)
	}
	for id, r := range results {
		e.written.Product[id] = r
	}
	for id := range e.written.Product {
		if _, ok := results[id]; !ok {
			delete(e.written.Product, id)
		}
	}
	e.written.At = start
	if err := writeGob(e.writtenPath(), &e.written); err != nil {
		return fmt.Errorf("saved to Shopify but could not record it locally: %w", err)
	}
	say("done in %s: %d metafields written, %d products refused (usually deleted)", time.Since(start).Round(time.Second), len(mfs), failed)
	return nil
}

func logTop(results map[uint64]Result, say func(string, ...any)) {
	ids := make([]uint64, 0, len(results))
	for id := range results {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return results[ids[a]].Score > results[ids[b]].Score })
	for i, id := range ids[:min(5, len(ids))] {
		r := results[id]
		say("  top %d: product %d score %d units %d", i+1, id, r.Score, r.Units)
	}
}
