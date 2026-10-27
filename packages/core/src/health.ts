import { durationToMilliseconds, durationToSeconds, type Duration } from './clock.ts';
import type { Container } from './container.ts';
import { withCode } from './error-codes.ts';

/**
 * One readiness check of `/up/ready`: an invokable class whose `handle()` throws (or rejects) when the check fails; what it
 * returns (`2 connections`) shows in the development details. See docs/health.md#writing-a-health-check.
 */
export interface HealthCheck {
  handle(): void | string | Promise<void | string>;
}

/** A health check's class: `static check` is its name; `static timeout` (seconds, or a {@link Duration}) overrides the default of 2 s and may be up to a minute. */
export type HealthCheckClass = (new (...args: any[]) => HealthCheck) & {
  readonly check: string;
  readonly timeout?: Duration;
};

/** @internal A part of `HealthReport`. What one check said. */
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

/** @internal What `/up/ready` is built from; its JSON is the API. What every check said: `ok` when each one is. */
export interface HealthReport {
  readonly ok: boolean;
  readonly checks: readonly HealthCheckResult[];
}

/** How long a check may take before it counts as failing (ms), unless its class says `static timeout`. */
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/** The longest `static timeout` a check may ask for (s); more can only be a value meant as milliseconds. */
const MAX_HEALTH_TIMEOUT_SECONDS = 60;

/**
 * The readiness checks of an app: those of every provider's `static health` (packages: database, redis, cache,
 * queue), the app's `health` and each module's `health` — one registry per app. `run()` runs them all at once, each with its
 * own time limit, and never throws.
 */
export class HealthChecks {
  readonly #checks: HealthCheckClass[] = [];

  /** @internal Built by the container. */
  constructor(checks: Iterable<HealthCheckClass> = []) {
    this.add(checks);
  }

  /** @internal Adds checks; the same class twice counts once, two classes with one name are a mistake. */
  add(checks: Iterable<HealthCheckClass>): this {
    for (const check of checks) {
      if (this.#checks.includes(check)) continue;
      if (typeof check !== 'function' || typeof check.check !== 'string' || check.check === '') {
        throw new TypeError(`${(check as { name?: string } | undefined)?.name ?? String(check)} is listed as a health check but has no \`static check = '<name>'\`.`);
      }
      if (check.timeout !== undefined) {
        let seconds: number;
        try {
          seconds = durationToSeconds(check.timeout);
        } catch (error) {
          throw new TypeError(`${check.name} has a \`static timeout\` that is no span of time: ${(error as Error).message}`, { cause: error });
        }
        if (seconds <= 0) throw new TypeError(withCode('K13', `${check.name} sets a \`static timeout\` of ${seconds} s; it must be above zero.`));
        if (seconds > MAX_HEALTH_TIMEOUT_SECONDS) {
          throw new TypeError(
            withCode('K13', `${check.name} sets a \`static timeout\` of ${seconds} s, over the ${MAX_HEALTH_TIMEOUT_SECONDS} s a health check may take. \`static timeout\` is in seconds — for 5000 ms write \`{ milliseconds: 5000 }\`.`),
          );
        }
      }
      const twin = this.#checks.find((other) => other.check === check.check);
      if (twin) throw new TypeError(`Two health checks are named "${check.check}": ${twin.name} and ${check.name}. Give one another \`static check\`.`);
      this.#checks.push(check);
    }
    return this;
  }

  /** @internal The registered checks, in order. */
  all(): readonly HealthCheckClass[] {
    return [...this.#checks];
  }

  /**
   * Runs every check at once, each built by `container` (a scope of its own) and given `timeout` (default 2 s, or its own
   * `static timeout`). A check that throws or takes longer fails; the report says which.
   * @internal
   */
  async run(container: Container, options: { timeout?: Duration } = {}): Promise<HealthReport> {
    const fallback = options.timeout === undefined ? DEFAULT_HEALTH_TIMEOUT_MS : durationToMilliseconds(options.timeout);
    const checks = await Promise.all(this.#checks.map((check) => runOne(check, container, check.timeout === undefined ? fallback : durationToMilliseconds(check.timeout))));
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
