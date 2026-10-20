import { withCode } from '@marmeon/core/internal';
import { CommandSetupError } from '../command.ts';
import type { CheckProblem, SilencedProblem } from './report.ts';

/** One check of `marmeon check`: `handle()` returns what it found (nothing: it passed); throwing makes the check `error`. See docs/check.md#checks-from-packages. */
export interface AppCheck {
  handle(context?: AppCheckContext): AppCheckResult | Promise<AppCheckResult>;
}

/** What a check is given. */
export interface AppCheckContext {
  /** Aborted when the check took longer than its time limit: stop, and release what you opened. */
  readonly signal: AbortSignal;
}

/**
 * What `handle()` returns: the findings (none: it passed), `{ skipped }` with why it did not run (a status `skipped`, no fault of the
 * app), or `{ problems, silenced }` when a `marmeon-check-ignore` comment silenced findings that stay in the report.
 */
export type AppCheckResult =
  | readonly CheckProblem[]
  | { readonly skipped: string }
  | { readonly problems: readonly CheckProblem[]; readonly silenced?: readonly SilencedProblem[] };

/**
 * A check's class. `static check` names it (kebab-case, unique among all checks); `static phase` says what of the app it needs:
 * `build` — the app is registered, nothing booted, no secret read (generated types, routes); `run` — the app is booted (anything
 * that reads configuration or opens a connection).
 */
export type AppCheckClass = (new (...args: any[]) => AppCheck) & {
  readonly check: string;
  readonly phase: 'build' | 'run';
  /** How long `handle()` may take, in ms. Default 60 000; past it the check is `error`. */
  readonly timeout?: number;
};

/** The names `marmeon check` uses itself. */
export const BUILT_IN_CHECKS = ['types', 'lint', 'internal-imports', 'raw-sql', 'inner-html', 'agents', 'boot', 'readiness'] as const;

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A check that cannot be registered: a bad or taken name, or no phase. Stops the app before it boots — and so every command — like a command name used twice. */
export class CheckSetupError extends CommandSetupError {
  override name = 'CheckSetupError';
}

/** All checks of the app: those of providers' `static checks` and modules' `checks`, in registration order. */
export class CheckRegistry {
  readonly #checks = new Map<string, { readonly check: AppCheckClass; readonly source: string }>();

  /**
   * Registers `checks`; adding the same class again is a no-op. A name that is not kebab-case, one of marmeon's own
   * (`types`, `lint`, `internal-imports`, `raw-sql`, `inner-html`, `agents`, `boot`, `readiness`), or taken by another class throws a {@link CheckSetupError}
   * naming both classes and their `source`, so no package takes over another's result.
   */
  add(checks: readonly AppCheckClass[], source = 'a package'): this {
    for (const check of checks) {
      const label = `${(check as { name?: string } | undefined)?.name || 'A check'} (${source})`;
      if (typeof check !== 'function' || typeof check.check !== 'string' || !NAME.test(check.check)) {
        throw new CheckSetupError(withCode('K11', `${label} needs a \`static check\` in kebab-case (\`'route-types'\`), got ${JSON.stringify((check as { check?: unknown } | undefined)?.check)}.`));
      }
      if (check.phase !== 'build' && check.phase !== 'run') {
        throw new CheckSetupError(withCode('K11', `${label} needs \`static phase = 'build' | 'run'\`, got ${JSON.stringify(check.phase)}.`));
      }
      if ((BUILT_IN_CHECKS as readonly string[]).includes(check.check)) {
        throw new CheckSetupError(withCode('K11', `"${check.check}" is one of marmeon's own checks — ${label} cannot use it. Rename it.`));
      }
      const taken = this.#checks.get(check.check);
      if (!taken) this.#checks.set(check.check, { check, source });
      else if (taken.check !== check) {
        throw new CheckSetupError(withCode('K11', `Two checks are named "${check.check}": ${taken.check.name} (${taken.source}) and ${check.name} (${source}). Rename one — its static check is how marmeon finds it.`));
      }
    }
    return this;
  }

  /** The checks of `phase`, in registration order. */
  all(phase: 'build' | 'run'): AppCheckClass[] {
    return [...this.#checks.values()].map((entry) => entry.check).filter((check) => check.phase === phase);
  }
}
