/**
 * Ports for the update check. `UpdateSource` abstracts where releases live (a
 * shared directory today) and how one is copied to local temp storage before
 * install; `AppRelauncher` abstracts restarting into a freshly installed binary.
 * The source does NOT interpret versions — that is domain logic (`semver.ts`).
 */

/** One release folder found in the update directory. */
export interface UpdateCandidate {
  /** Directory entry name, e.g. `octopus-1.2.0` (unparsed). */
  readonly name: string
  /** Absolute path to the release directory. */
  readonly path: string
}

export type ListCandidatesResult =
  | { readonly kind: 'ok'; readonly candidates: readonly UpdateCandidate[] }
  | { readonly kind: 'unreachable'; readonly reason: string }

export interface UpdateSource {
  /**
   * List installable release folders under `dir`. A missing dir, an I/O error or
   * a listing that exceeds `timeoutMs` (hung network mount) yields `unreachable`;
   * it never throws and never hangs past the timeout.
   */
  listCandidates(dir: string, timeoutMs: number): Promise<ListCandidatesResult>
  /** Copy the release directory to a fresh local temp dir; resolves to its path. */
  stageToTemp(releasePath: string): Promise<string>
  /** Remove a staged temp dir. Best-effort; never throws. */
  cleanup(tmpPath: string): Promise<void>
}

export interface AppRelauncher {
  /** Start `execPath` as the new app instance and quit the current one. */
  relaunch(execPath: string): void
}
