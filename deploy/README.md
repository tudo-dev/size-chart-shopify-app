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
  Without the editor (how it was done 2026-09-25): the key is public, so

  ```
  sed -i 's|^SHOPIFY_API_KEY=.*|SHOPIFY_API_KEY=0f8e54d5b874a56aeda52d19d0a5006a|' .env
  ```

  and the secret is pasted where nothing shows or keeps it:

  ```
  read -rsp 'Paste the secret and press Enter: ' S; S=${S#*=}; S=${S//[[:space:]]/}; sed -i "s|^SHOPIFY_API_SECRET=.*|SHOPIFY_API_SECRET=$S|" .env; unset S; echo
  grep -c '^SHOPIFY_API_SECRET=shpss_[0-9a-f]\{32\}$' .env
  ```

  The last line prints 1.
- `SHOPIFY_APP_URL=https://sizecharts.tudoholic.com` (already filled)
- `ALLOWED_SHOPS=tudoholic-com.myshopify.com` (already filled). Left empty,
  nobody can log in.

The picture-reading key is already on the server, inside Logistics. This copies
it across without showing it:

```
sed -i '/^ANTHROPIC_API_KEY=/d' .env && grep '^ANTHROPIC_API_KEY=' /srv/apps/tudoholic-logistics-app/.env >> .env && grep -c '^ANTHROPIC_API_KEY=.' .env
```

It prints `1`. Then:

```
cp deploy/deploy_sizecharts ~/ && chmod +x ~/deploy_sizecharts
~/deploy_sizecharts
```

It ends with "Deployment finished - the app answers on 127.0.0.1:3004".

## 3. Bring the charts over from Logistics (server, as `deploy`)

This copies the charts already read inside Logistics, their sheet uploads, the
product map, the two switches and the supplier pictures. Logistics is only
read. Do it now, before anyone opens the app on the store.

```
cd /srv/apps/size-chart-shopify-app
docker compose stop
docker compose run --rm --no-deps --entrypoint node -v /srv/apps/tudoholic-logistics-app/server/db:/logistics:ro -v "$PWD/scripts:/app/scripts:ro" sizecharts scripts/copy-from-logistics.mjs /logistics/db.sqlite
```

That only looks, and says what it would copy. **If it says the pictures are
missing for most charts, stop here**: it is reading the wrong folder. If it
looks right, run the same `docker compose run …` line again with ` --apply` on
the end. It ends with "Done. Every table matches Logistics". Then:

```
docker compose up -d
```

Run it a second time and it refuses, so nothing can be doubled. Logistics no
longer shows Size charts (removed 2026-09-24); its four tables and
server/db/size-chart-images stay only as this copy's source and a backup.

## 4. The web server and certificate (server, admin with sudo)

The `deploy` user is in the sudo group; `sudo` asks for its password.

```
sudo cp /srv/apps/size-chart-shopify-app/deploy/nginx/sizecharts.tudoholic.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sizecharts.tudoholic.com
```

Check: https://sizecharts.tudoholic.com/api/health shows `{"ok":true}`.

Certbot writes `listen 443 ssl;` into the live file, while every other site on
this server has `listen 443 ssl http2;`, and `nginx -t` then warns "protocol
options redefined for 0.0.0.0:443". Make it match (done 2026-09-25):

```
sudo sed -i 's/^\(\s*\)listen 443 ssl; # managed by Certbot$/\1listen 443 ssl http2; # managed by Certbot/' /etc/nginx/sites-enabled/sizecharts.tudoholic.com.conf
sudo nginx -t && sudo systemctl reload nginx
```

From then on the live file holds certbot's lines and is no longer the same as
`deploy/nginx/`. Never copy the repo file over it again. Keep backups in `~`,
never in `sites-enabled/`: nginx loads every file in that folder.

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

## 5. Shopify (laptop, in the size-chart-shopify-app folder)

```
shopify app deploy
```

This points the app at sizecharts.tudoholic.com. Until then it still points at
the laptop test address from `shopify app dev`.

Then install it on the store. The app lives in organization **132074704**
(`shopify app info` prints it), not the other "Tudoholic" one:
https://dev.shopify.com/dashboard/132074704/apps → Tudoholic Size Charts →
Distribution (it opens the Partner Dashboard) → **Custom distribution** (for
good: it cannot be changed) → store `tudoholic-com.myshopify.com`, multi-store
box unticked (the store is not on Plus) → Generate link → open the link while
logged in to the live store → Install. "Install app" on the dev dashboard only
offers the logx test store. Done 2026-09-25.

## 6. The first check

Open the app in the live store. The charts from Logistics are there. Tick one
switch on the page and untick it again: that makes the app get its own Shopify
key for the store. Then, on the server:

```
docker logs tudoholic-size-charts --tail 30
```

There should be no `[login] refused` line.

Once the charts show here, the reading key has no business in Logistics any
more. Delete its line there (nothing in Logistics reads it since 2026-09-24):

```
sed -i '/^ANTHROPIC_API_KEY=/d; /^SIZE_CHART_READER_MODEL=/d' /srv/apps/tudoholic-logistics-app/.env
```

It leaves the running Logistics as it is; its next `./deploy_logistics` starts
it without the key.
