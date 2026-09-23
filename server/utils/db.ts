import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as tables from '../db/schema'

let _db: BetterSQLite3Database<typeof tables> | null = null

/**
 * The app's own database — never Logistics'. Production names the file with
 * DATABASE_URL (docker-compose); a laptop uses server/db/db.sqlite. A server
 * with neither refuses to start rather than quietly writing somewhere else.
 */
export function useDb(): BetterSQLite3Database<typeof tables> {
  if (_db) return _db
  const file = process.env.DATABASE_URL
    || (import.meta.dev ? `${useRuntimeConfig().dbDir}/db.sqlite` : '')
  if (!file) throw new Error('No database configured: set DATABASE_URL')
  const sqlite = new Database(file)
  // Readers never wait for a writer, which matters once reading jobs run
  // beside the review page.
  sqlite.pragma('journal_mode = WAL')
  _db = drizzle(sqlite, { schema: tables })
  return _db
}
