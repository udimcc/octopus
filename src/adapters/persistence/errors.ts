/**
 * Persistence-layer errors. Unlike the pure {@link ../../domain/errors DomainError}
 * family (which is caught at command boundaries and never leaves the domain), these
 * signal an infrastructure condition detected while opening the SQLite database.
 * They surface at the composition-root / entry-point boot boundary, where the main
 * process turns them into a fatal user-facing dialog and quits (see `main/index.ts`).
 */

/**
 * Thrown when the on-disk database was written by a NEWER Octopus than the running
 * binary understands — i.e. `PRAGMA user_version` exceeds the binary's
 * {@link ../persistence/schema SCHEMA_VERSION}. This happens after a version
 * rollback with the shared data dir (DESIGN §6.3): a newer release migrated the DB
 * forward, then the user reverted to an older release. The forward-only migrations
 * cannot downgrade the schema, so the only safe action is to refuse to open it
 * rather than silently operate on (and corrupt the upgrade path of) a schema this
 * binary does not know.
 */
export class IncompatibleDbError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appVersion: number
  ) {
    super(
      `This Octopus data was created by a newer version of Octopus (database schema ` +
        `v${dbVersion}); this build understands up to schema v${appVersion}. Please ` +
        `use a newer Octopus, or restore the pre-upgrade backup saved next to the ` +
        `database as octopus.db.bak-v<N>.`
    )
    this.name = new.target.name
  }
}
