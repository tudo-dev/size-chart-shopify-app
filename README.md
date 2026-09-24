# Tudoholic Size Charts

An embedded Shopify admin app. It turns the 1688 supplier's size-chart picture
into an English chart in inches and centimetres, and shows it on the product
page of tudoholic.com.

Built the same way as Tudoholic Logistics (Nuxt, Polaris, SQLite, Docker) and
deployed beside it, but completely separate: its own Shopify app, permissions
(products and files only), address, database and deploy.

## Also in this repo: Tudoholic Ranking (separate feature)

`ranking/` is a **different feature** that only shares this repo and server: the
weekly product-ranking engine for the storefront (Go, its own Shopify app,
container, port 3005 and deploy). **Never delete or change `ranking/` as part of
Size Charts work.** See [ranking/README.md](ranking/README.md).

## Run it on a laptop

```
pnpm install
shopify app dev
```

## Checks

```
pnpm verify
pnpm lint
pnpm build
```
