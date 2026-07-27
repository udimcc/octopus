/**
 * In-memory `SessionTypeRegistry` (DESIGN §8). Static registration in V1 (only
 * the Terminal provider); the New-Session dropdown is populated purely from
 * `available(version)`, filtered by `availableFromVersion ≤ version` (§5.4). V3's
 * Jenkins is a new `register()` call at the composition root — zero edits here.
 */

import type { TypeId } from '../../domain/ids'
import type { SessionTypeProvider, SessionTypeRegistry } from '../../ports/session-type-provider'

export class InMemorySessionTypeRegistry implements SessionTypeRegistry {
  private readonly providers = new Map<string, SessionTypeProvider>()

  register(provider: SessionTypeProvider): void {
    this.providers.set(provider.typeId, provider)
  }

  get(typeId: TypeId): SessionTypeProvider | undefined {
    return this.providers.get(typeId)
  }

  available(version: number): readonly SessionTypeProvider[] {
    return [...this.providers.values()].filter((p) => p.availableFromVersion <= version)
  }
}
