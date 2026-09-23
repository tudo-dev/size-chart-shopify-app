# Tudoholic Size Charts

An embedded Shopify admin app. It turns the 1688 supplier's size-chart picture
into an English chart in inches and centimetres, and shows it on the product
page of tudoholic.com.

Built the same way as Tudoholic Logistics (Nuxt, Polaris, SQLite, Docker) and
deployed beside it, but completely separate: its own Shopify app, permissions
(products and files only), address, database and deploy.

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
