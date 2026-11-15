import { err, ok, type Container, type Resolver, type Result } from '@marmeon/core';
import { GuardRegistry } from './define-guard.ts';
import { GuardContext } from './guard-context.ts';
import { APP_GUARD_NAMES } from './guard-names.ts';

/**
 * The `--guard` option of the operator commands: the name of the guard they act on; without it, the app's. Declared as repeatable so
 * that a second `--guard` is seen and refused, not silently preferred to the first.
 */
export const GUARD_OPTION = { guard: { type: 'string', multiple: true } } as const;

/** The guard a command acts on: `name` is `undefined` for the app's, and `context()` builds what the services of that guard need. */
export interface OperatorGuard {
  readonly name: string | undefined;
  context(): GuardContext;
}

/**
 * Finds the guard an operator command acts on from its `--guard` option. It is built for the container that makes the command (a scope, or the
 * root), so the guard's users, stores and events come from the same scope as everything else the command is given. See
 * `docs/authentication.md#operator-commands-for-a-guard-of-a-package`.
 *
 * @internal
 */
export class OperatorGuards {
  readonly #resolver: Resolver;
  readonly #registry: Pick<Container, 'has'>;

  /** `registry` is the container the guards were registered in: it says whether there are any. */
  constructor(resolver: Resolver, registry: Pick<Container, 'has'>) {
    this.#resolver = resolver;
    this.#registry = registry;
  }

  /** The names of the package guards registered. */
  names(): string[] {
    return this.#registry.has(GuardRegistry) ? this.#resolver.make(GuardRegistry).all().map((guard) => guard.name) : [];
  }

  /**
   * No option or `web` is the app's guard; the name of a registered package guard is that guard, with its own tables. Anything else (an unknown name,
   * another spelling, a flag, two names) is refused with the list of names, never answered with the app's guard: a command meant for one circle of
   * users must not end up on another's.
   */
  resolve(option: unknown): Result<OperatorGuard, { readonly kind: 'refused'; readonly message: string }> {
    const list = `The guards are: ${[APP_GUARD_NAMES.name, ...this.names()].join(', ')}.`;
    const refuse = (message: string) => err({ kind: 'refused' as const, message: `${message} ${list}` });
    const values = option === undefined ? [] : Array.isArray(option) ? option : [option];
    if (values.length > 1) return refuse(`--guard is given once, not ${values.length} times.`);
    const name = values[0];
    if (name === undefined || name === APP_GUARD_NAMES.name) return ok({ name: undefined, context: () => this.#resolver.make(GuardContext) });
    if (typeof name !== 'string') return refuse('--guard names a guard, it is not a flag.');
    const guard = this.#registry.has(GuardRegistry) ? this.#resolver.make(GuardRegistry).all().find((candidate) => candidate.name === name) : undefined;
    if (guard === undefined) return refuse(`No guard is named ${JSON.stringify(name)}.`);
    return ok({ name: guard.name, context: () => this.#resolver.make(guard.tokens.context) });
  }
}
