/**
 * Domain-level errors. The domain enforces its invariants (§7) by throwing these
 * rather than returning error codes, so an illegal mutation cannot silently
 * corrupt an aggregate. The application layer catches them at command boundaries
 * and translates to `CommandResult`s; they never cross the IPC wire as objects.
 */

/** Base class for every error the pure domain raises. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A state-machine transition that the lifecycle tables forbid (§3.5, §3.6). */
export class IllegalTransitionError extends DomainError {}

/** An operation that would break an aggregate invariant (I6/I7/I9/I10, …). */
export class InvariantViolationError extends DomainError {}
