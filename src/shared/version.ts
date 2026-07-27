/**
 * The Octopus feature-set version (DESIGN §10). Distinct from the npm package
 * version: it gates which session types appear (`availableFromVersion ≤
 * CURRENT_VERSION`, §5.4/§8) and is exported to worktree scripts as
 * `OCTOPUS_VERSION` (§6.4). V1 ships as 1; V2/V3 bump it, and the dormant seams
 * defined in V1 light up without signature changes (§10).
 */
export const CURRENT_VERSION = 1
