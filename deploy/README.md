# Putting Tudoholic Size Charts on the server

The first time, in this order. After that, a deploy is only `~/deploy_sizecharts`.

## 1. The address (GoDaddy, tudoholic.com DNS)

Add one record: **Type** A, **Name** `sizecharts`, **Value** `91.98.238.254`.
Check it has arrived: `getent hosts sizecharts.tudoholic.com` prints the address.

## 2. The app (server, as `deploy`)

```
cd /srv/apps
git clone https://github.com/tudo-dev/size-chart-shopify-app.git
cd size-chart-shopify-app
cp .env.example .env
nano .env
```

In `.env`, fill in:

- `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`: THIS app's, not Logistics'.
  On the laptop, in the size-chart-shopify-app folder, `shopify app env show`
  prints them. Type them into the server's `.env` only, never into a chat.
- `SHOPIFY_APP_URL=https://sizecharts.tudoholic.com` (already filled)
- `ALLOWED_SHOPS=tudoholic-com.myshopify.com` (already filled). Left empty,
  nobody can log in.
- `ANTHROPIC_API_KEY`: the key for reading the pictures. It can be added
  later; until then, pictures wait to be read.

Then:

```
cp deploy/deploy_sizecharts ~/ && chmod +x ~/deploy_sizecharts
~/deploy_sizecharts
```

It ends with "Deployment finished - the app answers on 127.0.0.1:3004".

## 3. The web server and certificate (server, admin with sudo)

```
sudo cp /srv/apps/size-chart-shopify-app/deploy/nginx/sizecharts.tudoholic.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sizecharts.tudoholic.com
```

Check: https://sizecharts.tudoholic.com/api/health shows `{"ok":true}`.

While the admin is here, add these two lines inside `location /api/ { ... }`
in `/etc/nginx/sites-enabled/tudoholic-logistics-app.conf`, just under
`proxy_cache orders_cache;`, then run `sudo nginx -t && sudo systemctl reload nginx`:

```
    proxy_cache_bypass $http_authorization;
    proxy_no_cache $http_authorization;
```

That site keeps every GET /api answer for 10 seconds and hands it to anyone
asking for the same address. Since the login lock (2026-09-23), those answers
belong to whoever was logged in. With these two lines, nothing that carried a
login is ever kept.

## 4. Shopify (laptop, in the size-chart-shopify-app folder)

```
shopify app deploy
```

This points the app at sizecharts.tudoholic.com. Until then it still points at
the laptop test address from `shopify app dev`.

Then, in the Shopify dev dashboard: **Tudoholic Size Charts → Distribution →
Custom distribution**, store `tudoholic-com.myshopify.com`. Open the install
link while logged in to the live store, and install.

## 5. The first check

Open the app in the live store. Tick one switch on the page and untick it
again: that makes the app get its own Shopify key for the store. Then, on the
server:

```
docker logs tudoholic-size-charts --tail 30
```

There should be no `[login] refused` line.
