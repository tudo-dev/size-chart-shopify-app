// Tudoholic Ranking — storefront custom pixel.
//
// Paste this whole file into Shopify admin -> Settings -> Customer events ->
// Add custom pixel ("Tudoholic Ranking"). Permission: "Required: Analytics";
// data sale: "Data collected does not qualify as data sale". Save, then Connect.
//
// It sends only product ids and what happened to them: listed on a collection
// or search page (i), product page opened (v), added to cart (c), checkout
// started (k). No customer, no cart value, no address. Each product counts
// once per kind per shopper session, so the numbers are sessions, not clicks
// hammered by one person. Orders are NOT sent: the engine reads real sales
// straight from Shopify's reports.

const ENDPOINT = "https://sizecharts.tudoholic.com/rank/e";

const productId = (product) => {
  const id = product && product.id ? String(product.id).split("/").pop() : "";
  return /^\d{6,20}$/.test(id) ? id : null;
};

async function send(kind, ids) {
  ids = [...new Set(ids.filter(Boolean))].slice(0, 60);
  if (!ids.length) return;

  const key = "tudo-rank-" + kind;
  let seen = [];
  try {
    seen = JSON.parse((await browser.sessionStorage.getItem(key)) || "[]");
  } catch (e) {}
  const fresh = ids.filter((id) => !seen.includes(id));
  if (!fresh.length) return;
  try {
    await browser.sessionStorage.setItem(key, JSON.stringify(seen.concat(fresh).slice(-500)));
  } catch (e) {}

  // text/plain + no-cors: a "simple" request, so no CORS preflight round trip.
  fetch(ENDPOINT, {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ [kind]: fresh }),
  }).catch(() => {});
}

const listed = (variants) => (variants || []).map((v) => productId(v && v.product));

analytics.subscribe("collection_viewed", (event) => {
  send("i", listed(event.data.collection && event.data.collection.productVariants));
});

analytics.subscribe("search_submitted", (event) => {
  send("i", listed(event.data.searchResult && event.data.searchResult.productVariants));
});

analytics.subscribe("product_viewed", (event) => {
  send("v", [productId(event.data.productVariant && event.data.productVariant.product)]);
});

analytics.subscribe("product_added_to_cart", (event) => {
  const line = event.data.cartLine;
  send("c", [productId(line && line.merchandise && line.merchandise.product)]);
});

analytics.subscribe("checkout_started", (event) => {
  const lines = (event.data.checkout && event.data.checkout.lineItems) || [];
  send("k", lines.map((line) => productId(line.variant && line.variant.product)));
});
