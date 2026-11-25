import type { ListCandidatesResult, UpdateSource } from '../../ports/update-source'

/**
 * An {@link UpdateSource} that never finds a release. Wired by the composition root
 * on platforms without a self-update path (macOS): published releases are Linux
 * tarballs whose `install.sh` must never run on a Mac, even when `/mnt/scratch` or
 * a hidden `updates.dir` happens to be reachable. The checker then simply reports
 * "up to date", and with no candidate the installer has nothing to install.
 */
export class NullUpdateSource implements UpdateSource {
  listCandidates(): Promise<ListCandidatesResult> {
    return Promise.resolve({ kind: 'ok', candidates: [] })
  }

  stageToTemp(): Promise<string> {
    return Promise.reject(new Error('Self-update is not supported on this platform'))
  }

  cleanup(): Promise<void> {
    return Promise.resolve()
  }
}
