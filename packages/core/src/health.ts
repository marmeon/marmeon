import type { Container } from './container.ts';

/**
 * One readiness check: can this instance serve — is its database, its Redis, its cache reachable? An invokable class:
 * dependencies come through the constructor, `handle()` throws (or rejects) when the check fails. What it returns — a short
 * note like `2 connections` — shows in the development details of `/up/ready`.
 *
 * ```ts
 * export class StorageWritable implements HealthCheck {
 *   static check = 'storage';
 *   readonly #storage: Storage;
 *   constructor(storage: Storage) {
 *     this.#storage = storage;
 *   }
 *   async handle(): Promise<void> {
 *     await this.#storage.disk('local').put('.health', 'ok');
 *   }
 * }
 * defineModule({ name: 'system', health: [StorageWritable] });
 * ```
 */
export interface HealthCheck {
  handle(): void | string | Promise<void | string>;
}

/** A health check's class: `static check` is its name; `static timeout` (ms) overrides the default of 2 s. */
export type HealthCheckClass = (new (...args: any[]) => HealthCheck) & {
  readonly check: string;
  readonly timeout?: number;
};

/** What one check said. */
export interface HealthCheckResult {
  readonly name: string;
  readonly status: 'ok' | 'failing' | 'timeout';
  /** How long it took (ms) — for a timeout, how long it was given. */
  readonly ms: number;
  /** What `handle()` returned (`2 connections`). */
  readonly note?: string;
  /** Why it failed — raw: redact before showing. */
  readonly error?: unknown;
}

/** What every check said: `ok` when each one is. */
export interface HealthReport {
  readonly ok: boolean;
  readonly checks: readonly HealthCheckResult[];
}

/** How long a check may take before it counts as failing (ms), unless its class says `static timeout`. */
export const DEFAULT_HEALTH_TIMEOUT = 2_000;

/**
 * The readiness checks of an app: those of every provider's `static health` (packages: database, redis, cache,
 * queue), the app's `health` and each module's `health` — one registry per app. `run()` runs them all at once, each with its
 * own time limit, and never throws.
 */
export class HealthChecks {
  readonly #checks: HealthCheckClass[] = [];

  constructor(checks: Iterable<HealthCheckClass> = []) {
    this.add(checks);
  }

  /** Adds checks; the same class twice counts once, two classes with one name are a mistake. */
  add(checks: Iterable<HealthCheckClass>): this {
    for (const check of checks) {
      if (this.#checks.includes(check)) continue;
      if (typeof check !== 'function' || typeof check.check !== 'string' || check.check === '') {
        throw new TypeError(`${(check as { name?: string } | undefined)?.name ?? String(check)} is listed as a health check but has no \`static check = '<name>'\`.`);
      }
      const twin = this.#checks.find((other) => other.check === check.check);
      if (twin) throw new TypeError(`Two health checks are named "${check.check}": ${twin.name} and ${check.name}. Give one another \`static check\`.`);
      this.#checks.push(check);
    }
    return this;
  }

  /** The registered checks, in order. */
  all(): readonly HealthCheckClass[] {
    return [...this.#checks];
  }

  /**
   * Runs every check at once, each built by `container` (a scope of its own) and given `timeout` ms (or its own
   * `static timeout`). A check that throws or takes longer fails; the report says which.
   */
  async run(container: Container, { timeout = DEFAULT_HEALTH_TIMEOUT }: { timeout?: number } = {}): Promise<HealthReport> {
    const checks = await Promise.all(this.#checks.map((check) => runOne(check, container, check.timeout ?? timeout)));
    return { ok: checks.every((check) => check.status === 'ok'), checks };
  }
}

async function runOne(Check: HealthCheckClass, container: Container, timeout: number): Promise<HealthCheckResult> {
  const started = performance.now();
  const ms = () => Math.round((performance.now() - started) * 100) / 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeout);
  });
  const work = (async () => {
    const note = await container.createScope().make(Check).handle();
    return { note: typeof note === 'string' && note !== '' ? note : undefined };
  })();
  try {
    // `race` handles both: a check that fails after its time ran out is no unhandled rejection.
    const outcome = await Promise.race([work, expired]);
    if (outcome === 'timeout') return { name: Check.check, status: 'timeout', ms: timeout };
    return { name: Check.check, status: 'ok', ms: ms(), ...(outcome.note === undefined ? {} : { note: outcome.note }) };
  } catch (error) {
    return { name: Check.check, status: 'failing', ms: ms(), error };
  } finally {
    clearTimeout(timer);
  }
}
