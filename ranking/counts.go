package main

import (
	"encoding/gob"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The storefront pixel's counters: per product, per week, per event kind.
// Four weekly slots in a ring, so the engine always sees the last four weeks
// and older weeks fall off on their own, whether or not a ranking ran.
// 88 bytes per product that was ever seen; the whole catalogue fits in ~8 MB.
const (
	weeks = 4
	kinds = 4 // impression, view, cart, checkout
)

const (
	kImpr = iota
	kView
	kCart
	kCheckout
)

type week [kinds]uint32

type Counts struct {
	mu      sync.Mutex
	Week    int64 // ISO-ish week number (unix time / 7 days) of slot Cur
	Cur     int
	Product map[uint64]*[weeks]week
}

func newCounts() *Counts { return &Counts{Product: map[uint64]*[weeks]week{}} }

func weekOf(t time.Time) int64 { return t.Unix() / (7 * 24 * 3600) }

// advance moves the ring to the current week, emptying the slots it passes.
// Caller holds mu.
func (c *Counts) advance(now time.Time) {
	w := weekOf(now)
	if c.Week == 0 {
		c.Week = w
		return
	}
	for step := 0; c.Week < w && step < weeks; step++ {
		c.Week++
		c.Cur = (c.Cur + 1) % weeks
		for id, p := range c.Product {
			p[c.Cur] = week{}
			if *p == [weeks]week{} {
				delete(c.Product, id)
			}
		}
	}
	c.Week = w
}

func (c *Counts) add(now time.Time, kind int, ids []uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advance(now)
	for _, id := range ids {
		p := c.Product[id]
		if p == nil {
			p = new([weeks]week)
			c.Product[id] = p
		}
		p[c.Cur][kind]++
	}
}

// totals sums the four weeks into the ranking's Signals.
func (c *Counts) totals(now time.Time) map[uint64]*Signals {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advance(now)
	out := make(map[uint64]*Signals, len(c.Product))
	for id, p := range c.Product {
		var t week
		for _, w := range p {
			for k := range t {
				t[k] += w[k]
			}
		}
		out[id] = &Signals{Impr: float64(t[kImpr]), Views: float64(t[kView]), Carts: float64(t[kCart]), Checkouts: float64(t[kCheckout])}
	}
	return out
}

func (c *Counts) save(path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return writeGob(path, c)
}

func loadCounts(path string) *Counts {
	c := newCounts()
	if err := readGob(path, c); err != nil && !os.IsNotExist(err) {
		logf("counts: starting empty, could not read %s: %v", path, err)
		return newCounts()
	}
	if c.Product == nil {
		c.Product = map[uint64]*[weeks]week{}
	}
	return c
}

// ---- the pixel endpoint ----

// event is what pixel/custom-pixel.js sends: one list of product ids per
// kind, already de-duplicated per shopper session by the pixel.
type event struct {
	I []string `json:"i"`
	V []string `json:"v"`
	C []string `json:"c"`
	K []string `json:"k"`
}

const (
	maxBody     = 8 << 10
	maxIDs      = 60
	perIPMinute = 120
)

type limiter struct {
	mu     sync.Mutex
	minute int64
	seen   map[string]int
}

func (l *limiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if m := now.Unix() / 60; m != l.minute {
		l.minute, l.seen = m, map[string]int{}
	}
	l.seen[ip]++
	return l.seen[ip] <= perIPMinute
}

func collector(c *Counts) http.HandlerFunc {
	lim := &limiter{seen: map[string]int{}}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		now := time.Now()
		ip := r.Header.Get("X-Real-IP")
		if ip == "" {
			ip = r.RemoteAddr
		}
		if !lim.allow(ip, now) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
		var e event
		if err != nil || len(body) > maxBody || json.Unmarshal(body, &e) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for kind, list := range [kinds][]string{e.I, e.V, e.C, e.K} {
			if ids := productIDs(list); len(ids) > 0 {
				c.add(now, kind, ids)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// productIDs keeps plain numeric Shopify ids (or gid://shopify/Product/N),
// once each, at most maxIDs.
func productIDs(list []string) []uint64 {
	seen := make(map[uint64]bool, len(list))
	out := make([]uint64, 0, len(list))
	for _, s := range list {
		if len(out) == maxIDs {
			break
		}
		if id, ok := parseID(s); ok && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func parseID(s string) (uint64, bool) {
	s = s[strings.LastIndexByte(s, '/')+1:]
	if len(s) < 6 || len(s) > 20 {
		return 0, false
	}
	id, err := strconv.ParseUint(s, 10, 64)
	return id, err == nil && id > 0
}

// ---- small file helpers ----

func writeGob(path string, v any) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(f).Encode(v); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readGob(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return gob.NewDecoder(f).Decode(v)
}
