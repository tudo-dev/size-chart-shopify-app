import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './server/db/migrations',
  schema: './server/db/schema.ts',
  casing: 'snake_case',
  dialect: 'sqlite',
  dbCredentials: {
    // Production passes DATABASE_URL (docker-compose); a laptop uses the file here.
    url: process.env.DATABASE_URL || './server/db/db.sqlite',
  },
})
