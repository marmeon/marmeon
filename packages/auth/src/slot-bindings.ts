import { withCode } from '@marmeon/core/internal';
import type { Guard } from './define-guard.ts';

/** What a slot's own code refuses: error A8, told apart by class so the start check can report it exactly. @internal */
export class GuardSlotError extends TypeError {
  /** The message without its code, for a finding that carries the code beside it. */
  readonly detail: string;

  constructor(detail: string) {
    super(withCode('A8', detail));
    this.detail = detail;
  }
}

/**
 * The slots bound in a container and the target of each, by the slot object (two slots may share a name). A slot nobody bound has no
 * entry, and every use of it is error A8: there is no default, least of all the app's users.
 *
 * @internal
 */
export class SlotBindings {
  readonly #targets = new Map<object, 'web' | Guard>();
  #sealed = false;

  bind(slot: object, name: string, target: 'web' | Guard): void {
    if (this.#targets.has(slot)) throw new GuardSlotError(`The guard slot '${name}' is bound twice: a package binds its slot once, in its provider.`);
    this.#targets.set(slot, target);
  }

  target(slot: object): 'web' | Guard | undefined {
    return this.#targets.get(slot);
  }

  entries(): readonly (readonly [object, 'web' | Guard])[] {
    return [...this.#targets];
  }

  /**
   * Whether the auth provider has booted: a start is judging the routes, not a check that only registers the app. It does not stop a
   * later `bind()`; it says that an unbound slot found now is a mistake of the package, where before it may still be bound.
   */
  get sealed(): boolean {
    return this.#sealed;
  }

  /** Called when the auth provider boots. */
  seal(): void {
    this.#sealed = true;
  }
}
