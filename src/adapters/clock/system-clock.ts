/**
 * `Clock` backed by the system clock (DESIGN §2). The single ambient-time edge;
 * everything else takes timestamps as arguments so the domain stays pure and
 * tests inject a fixed clock.
 */

import type { Clock } from '../../ports/clock'

export const systemClock: Clock = {
  now: () => Date.now()
}
