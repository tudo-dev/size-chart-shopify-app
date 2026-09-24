// Tudoholic Ranking — a separate feature that lives in this repo beside
// Size Charts but shares nothing with it. See ranking/README.md.
//
//	ranking            serve: pixel endpoint + weekly ranking (the container's default)
//	ranking run        ask the running server for a ranking pass now
//	ranking run -dry   same, but only report what it would write
//	ranking health     exit 0 if the server answers (container healthcheck)
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

func logf(format string, args ...any) { log.Printf(format, args...) }

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	addr := env("ADDR", ":8080")

	if len(os.Args) > 1 && os.Args[1] == "run" {
		dry := len(os.Args) > 2 && os.Args[2] == "-dry"
		os.Exit(askForRun(addr, dry))
	}
	// The image has no shell or wget, so the container healthcheck calls this.
	if len(os.Args) > 1 && os.Args[1] == "health" {
		res, err := http.Get("http://127.0.0.1:" + addr[strings.LastIndexByte(addr, ':')+1:] + "/health")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	serve(addr)
}

// Nepal has no daylight saving, so a fixed offset is exact and the image
// needs no time-zone database.
var nepal = time.FixedZone("NPT", 5*3600+45*60)

// nextRun is the first Sunday 03:00 Nepal time after t: the quietest hour.
func nextRun(t time.Time) time.Time {
	l := t.In(nepal)
	d := time.Date(l.Year(), l.Month(), l.Day(), 3, 0, 0, 0, nepal)
	for d.Weekday() != time.Sunday || !d.After(t) {
		d = d.AddDate(0, 0, 1)
	}
	return d
}

func serve(addr string) {
	dir := env("DATA_DIR", "/data")
	shop := &Shop{
		Domain:   env("SHOPIFY_SHOP", "tudoholic-com.myshopify.com"),
		ClientID: os.Getenv("RANKING_CLIENT_ID"),
		Secret:   os.Getenv("RANKING_CLIENT_SECRET"),
		hc:       &http.Client{Timeout: 60 * time.Second},
	}
	if shop.ClientID == "" || shop.Secret == "" {
		logf("RANKING_CLIENT_ID / RANKING_CLIENT_SECRET are empty: the pixel is still counted, ranking passes will fail")
	}

	counts := loadCounts(dir + "/counts.gob")
	eng := &Engine{Shop: shop, Counts: counts, Dir: dir}
	eng.load()

	var running sync.Mutex
	pass := func(ctx context.Context, dry bool, say func(string, ...any)) error {
		if !running.TryLock() {
			return fmt.Errorf("a ranking pass is already running")
		}
		defer running.Unlock()
		return eng.Pass(ctx, dry, say)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/e", collector(counts))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"ok":true,"lastRun":%q}`, eng.written.At.Format(time.RFC3339))
	})
	// Only from inside the container (`docker compose exec ranking /ranking run`).
	// nginx forwards /rank/e and nothing else, so this is not reachable from outside either way.
	mux.HandleFunc("/admin/run", func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if r.Method != http.MethodPost || !net.ParseIP(host).IsLoopback() {
			http.NotFound(w, r)
			return
		}
		flusher, _ := w.(http.Flusher)
		say := func(f string, a ...any) {
			logf(f, a...)
			fmt.Fprintf(w, f+"\n", a...)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err := pass(r.Context(), r.URL.Query().Get("dry") == "1", say); err != nil {
			say("FAILED: %v", err)
		}
	})

	srv := &http.Server{Addr: addr, Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 2 * time.Hour}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	// Counters are saved every 5 minutes and on shutdown: a crash loses at most 5 minutes of pixel events.
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := counts.save(dir + "/counts.gob"); err != nil {
					logf("counts: save failed: %v", err)
				}
			}
		}
	}()

	// Weekly pass. A week missed while the server was down runs 2 minutes after start.
	go func() {
		for {
			next := nextRun(time.Now())
			if last := eng.written.At; !last.IsZero() && time.Since(last) > 8*24*time.Hour {
				next = time.Now().Add(2 * time.Minute)
			}
			logf("next ranking pass %s", next.In(nepal).Format("Mon 2 Jan 15:04 NPT"))
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Until(next)):
			}
			if err := pass(ctx, false, logf); err != nil {
				logf("ranking pass FAILED: %v", err)
				// Try again in 6 hours rather than waiting a week.
				select {
				case <-ctx.Done():
					return
				case <-time.After(6 * time.Hour):
				}
				if err := pass(ctx, false, logf); err != nil {
					logf("ranking retry FAILED: %v", err)
				}
			}
		}
	}()

	go func() {
		logf("tudoholic ranking listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
	if err := counts.save(dir + "/counts.gob"); err != nil {
		logf("counts: final save failed: %v", err)
	}
}

func askForRun(addr string, dry bool) int {
	port := addr[strings.LastIndexByte(addr, ':')+1:]
	u := "http://127.0.0.1:" + port + "/admin/run"
	if dry {
		u += "?dry=1"
	}
	res, err := http.Post(u, "text/plain", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "the ranking server is not answering:", err)
		return 1
	}
	defer res.Body.Close()
	var out strings.Builder
	io.Copy(io.MultiWriter(os.Stdout, &out), res.Body)
	if strings.Contains(out.String(), "FAILED:") {
		return 1
	}
	return 0
}
