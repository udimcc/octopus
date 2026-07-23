/**
 * `CredentialsProvider` port — SHAPE ONLY, no implementation in V1 (DESIGN §10
 * V1 seam, I16). Secrets are never persisted (I16): Jenkins config (V3) stores a
 * `credentialsRef`, and this port resolves it from the OS keychain (libsecret) at
 * runtime. Defining the shape now means V3 does not retrofit secret handling.
 */

export interface CredentialsProvider {
  /** Resolve an opaque credentials reference to a secret at runtime (never stored). */
  resolve(credentialsRef: string): Promise<string>
}
