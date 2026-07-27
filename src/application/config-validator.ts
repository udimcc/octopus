/**
 * `ConfigValidator` (DESIGN §8, §10 V1 seam). Validates a `SessionConfig` against
 * the session type's declarative `configSchema` (JSON Schema). ajv is a pure JS
 * library with no OS/framework coupling, so it is legal in the application layer
 * (the boundary rule forbids `adapters`, not npm libraries).
 *
 * In V1 this seam is real but low-stakes: the Terminal config the app builds is
 * always valid, so validation never rejects a normal flow. It exists so V2/V3
 * config dialogs get validation for free with no signature change (§10).
 */

import Ajv, { type ValidateFunction } from 'ajv'
import type { SessionConfig } from '../domain/session-config'

export interface ConfigValidationResult {
  readonly ok: boolean
  /** Human-readable reason when `ok` is false. */
  readonly error?: string
}

export interface ConfigValidator {
  /** Validate `config` against a session type's JSON `schema` (§8). */
  validate(schema: object, config: SessionConfig): ConfigValidationResult
}

/**
 * ajv-backed validator. Compiled validators are cached by schema identity so the
 * common case (one schema per session type) compiles once.
 */
export function createAjvConfigValidator(): ConfigValidator {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const cache = new WeakMap<object, ValidateFunction>()

  function compiled(schema: object): ValidateFunction {
    let fn = cache.get(schema)
    if (!fn) {
      fn = ajv.compile(schema)
      cache.set(schema, fn)
    }
    return fn
  }

  return {
    validate(schema, config) {
      const validate = compiled(schema)
      if (validate(config)) {
        return { ok: true }
      }
      return { ok: false, error: ajv.errorsText(validate.errors) }
    }
  }
}
