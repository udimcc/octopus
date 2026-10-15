/**
 * `CredentialsProvider` port (DESIGN §10 V1 seam, I16). Secrets are never
 * persisted in the DB or `settings.json`, and never returned to the renderer
 * (I16): callers resolve an opaque reference to a secret at runtime instead.
 *
 * The Jira API key (DESIGN "Jira import") is this port's first real
 * implementation — the adapter keeps the secret encrypted at rest, and it is never
 * returned to the renderer. Jenkins
 * config (V3) is expected to reuse the same shape with its own
 * `credentialsRef`, so defining `set`/`has` now means V3 does not retrofit
 * secret handling.
 */

/** Secret reference for the Jira API key (DESIGN "Jira import", I16). */
export const JIRA_API_KEY_REF = 'jira-api-key'

export interface CredentialsProvider {
  /** Resolve an opaque credentials reference to a secret at runtime (never stored). */
  resolve(credentialsRef: string): Promise<string>
  /** Set or clear (`null`) the secret for a reference. */
  set(ref: string, secret: string | null): Promise<void>
  /** Whether a secret is currently set for a reference. */
  has(ref: string): Promise<boolean>
}
