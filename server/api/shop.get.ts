/**
 * Which store the app is connected to, asked of Shopify itself. The first
 * thing the page shows, and the proof that login, token exchange and the
 * saved token all work end to end.
 */
export default defineEventHandler(async (event) => {
  const { client, shop } = await getClient(event)
  const response = await client.request<{ shop: { name: string, myshopifyDomain: string } }>(
    `query { shop { name myshopifyDomain } }`,
  )
  return {
    shop,
    name: response.data?.shop.name ?? shop,
  }
})
