/**
 * Is the server up? For Docker's health check and the deploy script. Says
 * nothing about any shop, so it needs no login.
 */
export default defineEventHandler(() => ({ ok: true }))
