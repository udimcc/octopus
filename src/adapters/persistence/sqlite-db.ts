/**
 * The minimal slice of the better-sqlite3 `Database` API that {@link SqliteStore}
 * uses. Declaring it as an interface (structurally satisfied by a real
 * `Database`) lets the store depend on a *type* rather than the native module, so
 * the store loads and unit-tests under host Node — where the Electron-ABI
 * `better_sqlite3.node` binary cannot `dlopen`. The concrete `Database` is
 * constructed only in `open-database.ts`, the sole file that imports the binary.
 */

/**
 * A prepared statement. better-sqlite3 binds params either positionally
 * (variadic) or by name (a single object whose keys match `@name` placeholders),
 * so the methods are variadic to accept both call shapes.
 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDb {
  /** Execute one or more statements with no bound params (DDL, pragmas). */
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  /** Wrap `fn` so calling the result runs it inside a single transaction. */
  transaction<T>(fn: () => T): () => T
  /** Run a `PRAGMA` (e.g. `wal_checkpoint(TRUNCATE)`). */
  pragma(source: string): unknown
  close(): void
}
