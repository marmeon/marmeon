import type { Application } from './application.ts';

/**
 * A way out of an error, as the development error page shows it (E130): what to do, why, the command to copy and where the
 * docs are. **Text only** — no endpoint ever runs a solution (Ignition's runnable solutions were CVE-2021-3129).
 */
export interface Solution {
  /** What to do, short: `Run the pending migrations`. */
  readonly title: string;
  /** Why, and what else to know — plain text. */
  readonly text: string;
  /** A command to copy (`marmeon migrate`) — shown, never run. */
  readonly command?: string;
  /** Where it is documented: a page of the docs with its anchor (`docs/migrations.md#running-migrations`), or any URL. */
  readonly docs?: string;
}

/** What a solution may look at: the app the error happened in — absent for an error before it booted (the CLI). */
export interface SolutionContext {
  readonly app?: Application;
}

type ErrorClass<E> = abstract new (...args: any[]) => E;

/** One entry of {@link defineSolutions}: for errors of a class (and its subclasses), when `when` says so. */
export interface SolutionDefinition<E = Error> {
  readonly for: ErrorClass<E>;
  /** Narrows it further — `(e) => e.reason === 'unbound'`. Default: every error of the class. */
  readonly when?: (error: E) => boolean;
  /** The solution — or none after all (a database solution that finds no pending migration). May look things up. */
  readonly solve: (error: E, context: SolutionContext) => Solution | undefined | Promise<Solution | undefined>;
}

/**
 * Solutions for a package's (or an app's) errors (E130) — a provider lists them as `static solutions`, the development error
 * page shows the ones that match:
 *
 * ```ts
 * export const solutions = defineSolutions([
 *   {
 *     for: ContainerError,
 *     when: (e) => e.reason === 'unbound',
 *     solve: (e) => ({ title: `Bind ${e.key} in a service provider`, text: '…', docs: 'docs/container.md#binding-services' }),
 *   },
 * ]);
 * export class MyServiceProvider { static solutions = solutions; … }
 * ```
 *
 * Each entry's `when` and `solve` get the error typed by its `for`.
 */
export function defineSolutions<const Classes extends readonly ErrorClass<unknown>[]>(
  definitions: { readonly [I in keyof Classes]: SolutionDefinition<InstanceType<Classes[I]>> & { readonly for: Classes[I] } },
): readonly SolutionDefinition<any>[] {
  return Object.freeze([...(definitions as readonly SolutionDefinition<any>[])]);
}

/**
 * The solutions an app knows (E130): the core's, those of every provider's `static solutions` (packages and the app) — one
 * registry per app. `find` looks through an error and its causes.
 */
export class ErrorSolutions {
  readonly #definitions: SolutionDefinition<any>[] = [];

  constructor(definitions: Iterable<SolutionDefinition<any>> = []) {
    this.add(definitions);
  }

  add(definitions: Iterable<SolutionDefinition<any>>): this {
    for (const definition of definitions) if (!this.#definitions.includes(definition)) this.#definitions.push(definition);
    return this;
  }

  /**
   * The solutions for `error` and its causes (`error.cause`, five deep), each title once. A solution that fails to look
   * something up counts as none — the error page must never fail over its hints.
   */
  async find(error: unknown, context: SolutionContext = {}): Promise<Solution[]> {
    const found: Solution[] = [];
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      for (const definition of this.#definitions) {
        if (!(current instanceof definition.for)) continue;
        try {
          if (definition.when && !definition.when(current)) continue;
          const solution = await definition.solve(current, context);
          if (solution && !found.some((other) => other.title === solution.title)) found.push(solution);
        } catch {
          // A hint that cannot be worked out is left out.
        }
      }
      current = current.cause;
    }
    return found;
  }
}
