package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRankOrdersByQuality(t *testing.T) {
	sig := map[uint64]*Signals{
		1: {Impr: 2000, Views: 200, Carts: 40, Checkouts: 20, Orders: 12, Units: 15}, // strong
		2: {Impr: 2000, Views: 200, Carts: 10, Checkouts: 4, Orders: 2, Units: 2},    // average-ish
		3: {Impr: 2000, Views: 200, Carts: 1},                                        // looked at, never bought
		4: {Units: 30, Orders: 25},                                                   // sales only, no pixel yet
	}
	r := Rank(sig)
	if !(r[1].Score > r[2].Score && r[2].Score > r[3].Score) {
		t.Fatalf("expected 1 > 2 > 3, got %d %d %d", r[1].Score, r[2].Score, r[3].Score)
	}
	if r[4].Score <= r[3].Score {
		t.Fatalf("a real best seller with no pixel data must beat a non-seller: %d vs %d", r[4].Score, r[3].Score)
	}
	if r[4].Units != 30 {
		t.Fatalf("units = %d", r[4].Units)
	}
	for id, res := range r {
		if res.Score < 1 || res.Score > 1000 {
			t.Fatalf("product %d score %d out of range", id, res.Score)
		}
	}
}

func TestRankHidesOnlyTheEvidencedBottomThatNeverSold(t *testing.T) {
	sig := map[uint64]*Signals{}
	for i := uint64(1); i <= 100; i++ {
		// 100 products all seen 100 times; the first 30 never sold.
		s := &Signals{Impr: 1000, Views: 100, Carts: float64(i % 7)}
		if i > 30 {
			s.Orders, s.Units = 3, 3
		}
		sig[i] = s
	}
	sig[500] = &Signals{Views: 3} // too little evidence to judge
	r := Rank(sig)
	hidden := 0
	for id, res := range r {
		if res.Hide {
			hidden++
			if id > 30 {
				t.Fatalf("product %d sold and was hidden", id)
			}
		}
	}
	if hidden != 3 { // 10% of the 30 evidenced non-sellers
		t.Fatalf("hidden = %d, want 3", hidden)
	}
	if r[500].Hide {
		t.Fatal("a product with 3 views must not be judged")
	}
}

func TestRankEmptyAndReturns(t *testing.T) {
	if len(Rank(map[uint64]*Signals{})) != 0 {
		t.Fatal("empty in, empty out")
	}
	r := Rank(map[uint64]*Signals{
		1: {Views: 100, Orders: 10, Units: 10},
		2: {Views: 100, Orders: 10, Units: 10, Returned: 0.8},
	})
	if r[2].Score >= r[1].Score {
		t.Fatalf("returns must cost score: %d vs %d", r[2].Score, r[1].Score)
	}
}

func TestCountsRingDropsOldWeeks(t *testing.T) {
	c := newCounts()
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	c.add(t0, kView, []uint64{111111})
	c.add(t0.Add(8*24*time.Hour), kView, []uint64{111111, 222222})
	if got := c.totals(t0.Add(8 * 24 * time.Hour))[111111].Views; got != 2 {
		t.Fatalf("two weeks summed: %v", got)
	}
	// 4+ weeks after the first event, only the second week's count is left.
	tot := c.totals(t0.Add(29 * 24 * time.Hour))
	if got := tot[111111].Views; got != 1 {
		t.Fatalf("oldest week should be gone: %v", got)
	}
	if len(c.totals(t0.Add(90*24*time.Hour))) != 0 {
		t.Fatal("everything older than 4 weeks is dropped, entries included")
	}
}

func TestCountsSaveLoad(t *testing.T) {
	path := t.TempDir() + "/counts.gob"
	c := newCounts()
	now := time.Now()
	c.add(now, kCart, []uint64{7777777})
	if err := c.save(path); err != nil {
		t.Fatal(err)
	}
	back := loadCounts(path)
	if back.totals(now)[7777777].Carts != 1 {
		t.Fatal("round trip lost the count")
	}
	os.WriteFile(path, []byte("garbage"), 0o644)
	if len(loadCounts(path).Product) != 0 {
		t.Fatal("unreadable file must start empty, not crash")
	}
}

func TestCollector(t *testing.T) {
	c := newCounts()
	h := collector(c)
	post := func(body string, ip string) int {
		req := httptest.NewRequest(http.MethodPost, "/e", strings.NewReader(body))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set("X-Real-IP", ip)
		w := httptest.NewRecorder()
		h(w, req)
		return w.Code
	}
	body, _ := json.Marshal(event{
		I: []string{"8123456789", "8123456789", "gid://shopify/Product/8123456790", "abc", "12"},
		V: []string{"8123456789"},
		K: []string{"8123456790"},
	})
	if code := post(string(body), "1.1.1.1"); code != http.StatusNoContent {
		t.Fatalf("code %d", code)
	}
	tot := c.totals(time.Now())
	if len(tot) != 2 || tot[8123456789].Impr != 1 || tot[8123456789].Views != 1 || tot[8123456790].Checkouts != 1 {
		t.Fatalf("unexpected counts: %+v %+v", tot[8123456789], tot[8123456790])
	}
	if post("{not json", "1.1.1.1") != http.StatusBadRequest {
		t.Fatal("bad json accepted")
	}
	if post(strings.Repeat("x", maxBody+10), "1.1.1.1") != http.StatusBadRequest {
		t.Fatal("oversized body accepted")
	}
	limited := false
	for i := 0; i < perIPMinute+5; i++ {
		if post(`{"v":["8123456789"]}`, "2.2.2.2") == http.StatusTooManyRequests {
			limited = true
		}
	}
	if !limited {
		t.Fatal("per-IP limit never kicked in")
	}
}

func TestDecodeRowsBothShapes(t *testing.T) {
	cols := []struct {
		Name string `json:"name"`
	}{{"product_id"}, {"orders"}}
	a := decodeRows(json.RawMessage(`[{"product_id":8123456789,"orders":"3"}]`), cols)
	b := decodeRows(json.RawMessage(`[["8123456789", 3]]`), cols)
	for _, rows := range [][]map[string]any{a, b} {
		id, ok := rowID(rows[0]["product_id"])
		if len(rows) != 1 || !ok || id != 8123456789 || num(rows[0]["orders"]) != 3 {
			t.Fatalf("decoded %+v", rows)
		}
	}
}

func TestNextRunIsSundayThreeAMNepal(t *testing.T) {
	from := time.Date(2026, 9, 24, 10, 0, 0, 0, nepal) // a Thursday
	n := nextRun(from)
	if n.Weekday() != time.Sunday || n.Hour() != 3 || !n.After(from) || n.Sub(from) > 7*24*time.Hour {
		t.Fatalf("next run %v", n)
	}
	if again := nextRun(n); again.Sub(n) != 7*24*time.Hour {
		t.Fatalf("a week later expected, got %v", again)
	}
}
