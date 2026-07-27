/**
 * Port for reading the current time (DESIGN §2). Injected so timestamps
 * (createdAt, exitedAt, provisionedAt) are deterministic in tests and the domain
 * performs no ambient I/O.
 */

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number
}
