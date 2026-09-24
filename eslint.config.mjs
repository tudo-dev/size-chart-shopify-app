// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  // ranking/ is a separate Go feature (ranking/README.md), not part of this app.
  ignores: ['server/db/migrations/**', 'ranking/**'],
})
