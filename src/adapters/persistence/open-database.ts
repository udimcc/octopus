/**
 * The single seam where the native better-sqlite3 binary is loaded. Isolated in
 * its own module so that everything else in `persistence/` depends only on the
 * {@link SqliteDb} interface and stays loadable under host Node (the compiled
 * `better_sqlite3.node` is built for Electron's ABI — NODE_MODULE_VERSION 130 —
 * and cannot `dlopen` under the host's Node ABI; §M0). This module is imported
 * exclusively from the composition root, which runs inside Electron.
 *
 * A real `Database` structurally satisfies `SqliteDb`, so no adapter shim is
 * needed — the cast documents the intended narrowing.
 */

import Database from 'better-sqlite3'
import type { SqliteDb } from './sqlite-db'
import { SqliteStore } from './sqlite-store'

/**
 * Open (creating if absent) the SQLite database at `dbPath` and return a store
 * with schema applied. The parent directory must already exist (`ensureAppDirs`).
 */
export function openSqliteStore(dbPath: string): SqliteStore {
  const db = new Database(dbPath) as unknown as SqliteDb
  return SqliteStore.create(db)
}
