# Tudoholic Ranking

> **A separate feature. Not part of Size Charts.** It only lives in this repo
> and on this server to share the machine. It has its own Shopify app, its own
> container (`tudoholic-ranking`, port 3005), its own data folder and its own
> deploy script. **Do not delete, move or "clean up" `ranking/` while working
> on Size Charts**, and do not fold it into the Nuxt app. The storefront theme
> (tudo-dev/shopify-website) reads what it writes.

Every Sunday 03:00 Nepal time it scores every product on how well it actually
sells once people see it, and writes three product metafields that the
storefront's "Popular in <Category>" rail uses:

| Metafield | Type | Meaning |
|---|---|---|
| `tudo.rank_score` | integer 1–1000 | quality score; 0/absent = no data yet |
| `tudo.rail_hide` | boolean | the week's bottom performers: kept out of the rails |
| `custom.units_sold_30d` | integer | net units sold in 30 days (the theme already read this; nothing filled it before) |

Products are **never** unpublished or changed otherwise. A hidden product is
still live and buyable; next week it is judged again and can come back.

## Where the numbers come from

**Shopify's own reports (from day one):** net units sold, orders and return
rate per product (ShopifyQL `sales`, 30 days), and Shopify's recommendation
blocks: shown → clicked → added to cart → bought (`product_recommendation_conversions`).

**The storefront pixel (`pixel/custom-pixel.js`, builds up over 4 weeks):**
listed on a collection/search page → product page opened → added to cart →
checkout started. Shopify's reports have no per-product version of this funnel,
which is why the pixel exists. Counted once per product per shopper session.
Only product ids are sent.

## How a score is made (`rank.go`)

Rates (click-through, add-to-cart, checkout, buy) are smoothed toward the store
average, so 1 sale from 2 views is not "50%", compared with that average and
capped at 3×. Weighted: buy 30 %, sales volume 25 %, add-to-cart 20 %, click-
through 15 %, reaching checkout 10 %; a high return rate costs up to half.

**Weekly cut:** of the products shown enough to judge (40+ views or 500+
listings in 4 weeks) that sold nothing, the lowest-scoring 10 % get
`rail_hide = true`. Products that sold anything are never hidden.

**Cheap by design:** one static Go binary, no dependencies, ~8 MB image, 64 MB
memory cap. Pixel counters are in memory (≈88 bytes per product seen), saved to
`data/counts.gob` every 5 minutes; weeks older than 4 fall off on their own.
Each pass writes only metafields whose value changed, and refuses to write at
all if the sales report fails or would wipe most existing scores.

## Setup (first time)

1. **Shopify app (Dev Dashboard, dev.shopify.com).** Create app "Tudoholic
   Ranking" in the Tudoholic organization. New version → access scopes
   `read_reports, read_products, write_products` → release. API access →
   Protected customer data → request Level 2 (Shopify requires it for reports;
   the engine reads no customer data). Install it on tudoholic-com.myshopify.com.
2. **Server, as `deploy`:**
   ```
   cd /srv/apps/size-chart-shopify-app && git pull origin main
   cd ranking && cp .env.example .env && nano .env    # Client ID + secret from the app's Settings
   cp deploy/deploy_ranking ~/ && chmod +x ~/deploy_ranking && ~/deploy_ranking
   ```
3. **Server, admin with sudo:** add the `include` line from
   `deploy/nginx/ranking-location.conf` to the sizecharts 443 block, then
   `sudo nginx -t && sudo systemctl reload nginx`.
4. **First pass, dry:** `docker exec tudoholic-ranking /ranking run -dry` prints
   what it would write. If it looks right: `docker exec tudoholic-ranking /ranking run`.
5. **Pixel:** Shopify admin → Settings → Customer events → Add custom pixel →
   paste `pixel/custom-pixel.js` → Save → Connect.

After that: `~/deploy_ranking` after a change, `docker logs tudoholic-ranking`
to see passes. Tests: `CGO_ENABLED=0 go test ./...` (the Docker build runs them too).
