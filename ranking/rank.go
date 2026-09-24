package main

import (
	"math"
	"sort"
)

// Signals is everything known about one product over the ranking window.
// Shopify's own reports fill Units/Orders/Returned (sales) and the
// recommendation-block funnel; the storefront pixel fills Impr/Views/Carts/
// Checkouts. Either side alone is enough to score a product.
type Signals struct {
	Impr      float64 // times it was listed on a collection or search page
	Views     float64 // sessions that opened its product page
	Carts     float64 // sessions that added it to the cart
	Checkouts float64 // sessions that started checkout with it in the cart
	Orders    float64 // orders that contained it (Shopify sales)
	Units     float64 // net units sold (Shopify sales)
	Returned  float64 // share of sold units returned, 0..1 (Shopify sales)
}

// Result is what gets written onto the product.
type Result struct {
	Score uint16 // 1..1000; 0 is never written as a score, it means "no data"
	Hide  bool   // bottom of the evidenced products: kept out of the rails
	Units uint32 // custom.units_sold_30d, already read by the theme
}

const (
	priorViews = 30.0  // a product needs ~30 views before its own rates outweigh the store average
	priorImpr  = 300.0 // same, for listing impressions
	priorCarts = 10.0

	// Hiding: only products that have been seen enough to judge, never one that sold.
	hideMinViews = 40.0
	hideMinImpr  = 500.0
	hideShare    = 0.10
)

// Rank scores every product against the store's own averages. Each rate is
// smoothed toward the store average (a product with 2 views and 1 sale is not
// "50% conversion"), then compared with that average and capped at 3x, so no
// single lucky number can dominate.
func Rank(sig map[uint64]*Signals) map[uint64]Result {
	var sumI, sumV, sumC, sumK, sumO, maxUnits float64
	for _, s := range sig {
		sumI += s.Impr
		sumV += s.Views
		sumC += s.Carts
		sumK += s.Checkouts
		sumO += s.Orders
		maxUnits = math.Max(maxUnits, s.Units)
	}
	ctr0 := ratio(sumV, sumI, 0.02)
	atc0 := ratio(sumC, sumV, 0.05)
	chk0 := ratio(sumK, sumC, 0.40)
	buy0 := ratio(sumO, sumV, 0.01)

	out := make(map[uint64]Result, len(sig))
	type judged struct {
		id    uint64
		score uint16
	}
	var evidenced []judged

	for id, s := range sig {
		ctr := (math.Min(s.Views, s.Impr) + priorImpr*ctr0) / (s.Impr + priorImpr)
		atc := (s.Carts + priorViews*atc0) / (s.Views + priorViews)
		chk := (s.Checkouts + priorCarts*chk0) / (s.Carts + priorCarts)
		buy := (s.Orders + priorViews*buy0) / (s.Views + priorViews)
		vol := 0.0
		if maxUnits > 0 {
			vol = math.Log1p(s.Units) / math.Log1p(maxUnits)
		}

		q := 0.30*rel(buy, buy0) + 0.20*rel(atc, atc0) + 0.10*rel(chk, chk0) +
			0.15*rel(ctr, ctr0) + 0.25*vol
		q *= 1 - 0.5*clamp01(s.Returned)

		r := Result{Score: uint16(math.Round(1 + 999*clamp01(q))), Units: uint32(math.Max(0, math.Round(s.Units)))}
		out[id] = r
		if s.Orders == 0 && s.Units <= 0 && (s.Views >= hideMinViews || s.Impr >= hideMinImpr) {
			evidenced = append(evidenced, judged{id, r.Score})
		}
	}

	// The weekly cut: the lowest-scoring tenth of the products shoppers have
	// actually been shown, and still did not buy, drop out of the rails.
	sort.Slice(evidenced, func(a, b int) bool {
		if evidenced[a].score != evidenced[b].score {
			return evidenced[a].score < evidenced[b].score
		}
		return evidenced[a].id < evidenced[b].id
	})
	for _, e := range evidenced[:int(float64(len(evidenced))*hideShare)] {
		r := out[e.id]
		r.Hide = true
		out[e.id] = r
	}
	return out
}

// rel compares a smoothed rate with the store average: 1/3 = average, 1 = 3x or better.
func rel(x, avg float64) float64 {
	if avg <= 0 {
		return 1.0 / 3
	}
	return math.Min(x/avg, 3) / 3
}

func ratio(num, den, fallback float64) float64 {
	if num <= 0 || den <= 0 {
		return fallback
	}
	return math.Min(num/den, 1)
}

func clamp01(x float64) float64 { return math.Max(0, math.Min(1, x)) }
