# Tudoholic Size Charts

An embedded Shopify admin app. It turns the 1688 supplier's size-chart picture
into an English chart in inches and centimetres, and shows it on the product
page of tudoholic.com.

Built the same way as Tudoholic Logistics (Nuxt, Polaris, SQLite, Docker) and
deployed beside it, but completely separate: its own Shopify app, permissions
(products and files only), address, database and deploy.

## Run it on a laptop

Live on tudoholic-com.myshopify.com since 2026-09-25. `shopify app dev` no
longer moves the app's address to the laptop (`automatically_update_urls_on_dev
= false`), so the store keeps opening the server. Check changes with the
commands below, then deploy with `~/deploy_sizecharts` on the server.

```
pnpm install
```

## Checks

```
pnpm verify
pnpm lint
pnpm build
```
