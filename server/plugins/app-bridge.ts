/**
 * Shopify App Bridge, loaded the way Tudoholic Logistics loads it. It is what
 * makes the page an app inside Shopify admin, and it adds the session token
 * to every request the page makes to this server — the token getClient checks.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html) => {
    html.head.unshift(`
<meta name="shopify-api-key" content="${process.env.SHOPIFY_API_KEY ?? ''}" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
`)
  })
})
