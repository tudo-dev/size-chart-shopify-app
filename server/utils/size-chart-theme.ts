/**
 * Where the website shows the charts: the "Size chart" box of this app's
 * theme app extension (extensions/size-chart), added to the product page in
 * the theme editor.
 *
 * The link is Shopify's documented deep link (shopify.dev, theme app
 * extensions, checked 2026-09-25): it opens the LIVE theme's editor on the
 * product template with the box ready to drop into the main product section.
 * Nothing changes on the website until someone presses Save there. Draft
 * themes (NewSite, the copy used for testing) get the box by hand: Customize,
 * a product page, Add block, Apps, Size chart.
 */

import { shopifyCredentials } from './scopes'

/** The block's file name in extensions/size-chart/blocks/ — the handle Shopify knows it by. Never rename it: placed boxes would disappear. */
export const SIZE_CHART_BLOCK_HANDLE = 'size-chart'

/**
 * An in-admin link (App Bridge opens `shopify://admin/...` links in the
 * admin), or null when the app's key is not known.
 */
export function themeEditorLink(apiKey: string = shopifyCredentials().apiKey): string | null {
  if (!/^[0-9a-f]{32}$/i.test(apiKey)) return null
  // Written out as Shopify documents it, slash and all (URLSearchParams would encode the slash).
  return `shopify://admin/themes/current/editor?template=product&addAppBlockId=${apiKey}/${SIZE_CHART_BLOCK_HANDLE}&target=mainSection`
}
