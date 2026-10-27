import { AsyncLocalStorage } from 'node:async_hooks';
import { Container } from './container.ts';
import { withCode } from './error-codes.ts';
import { Logger, type LogContext } from './logger.ts';
import { Redactor } from './redact.ts';
import { outsideTransaction } from './transaction-context.ts';

/**
 * An error as a reporter sees it: only the masked view. Name, message and stack went through the app's `Redactor`, so a
 * connection URL, a token or the session cookie an error quotes is gone; the original error object never reaches a reporter.
 * Frozen, like everything in a report. See docs/errors.md#reporting.
 */
export interface ReportedError {
  /** The error's class name when it is an identifier, else `Error`. */
  readonly name: string;
  readonly message: string;
  readonly stack: string;
  /** The error's own `code` (`ECONNREFUSED`, `23505`), when it has one. */
  readonly code: string | undefined;
  /** The HTTP status of an `HttpError`, when the error has one. */
  readonly status: number | undefined;
  /** The error that caused this one, masked the same way — at most {@link MAX_REPORTED_CAUSES} levels deep. */
  readonly cause: ReportedError | undefined;
}

/** What a reporter is told about an error: the masked error and where it happened. See docs/errors.md#reporting. */
export interface ErrorReport {
  readonly error: ReportedError;
  /** What ran when the error happened. */
  readonly source: 'request' | 'job' | 'schedule' | 'command';
  /**
   * Masked facts about the place: for a request its `method`, `route` (name) and `path` (without the query), and `phase` when the
   * error came after the response was sent (`deferred`, `after-response` or `terminate`).
   */
  readonly context: Readonly<Record<string, string>>;
}

/**
 * Sends the errors an app has to know about to a service. A provider brings one with `static errorReporters`; the class is built
 * by the container once, at boot. `report` is never awaited by a request and runs outside any transaction.
 * See docs/errors.md#reporting.
 */
export interface ErrorReporter {
  report(report: ErrorReport): void | Promise<void>;
  /** Sends what is still buffered; called when the app shuts down, which waits at most {@link FLUSH_TIMEOUT} ms. */
  flush?(): Promise<void>;
}

/** An error reporter's class, as listed in a provider's `static errorReporters`. */
export type ErrorReporterClass = new (...args: any[]) => ErrorReporter;

/** The most reports one reporter has in flight; more are dropped (a storm of errors must not fill the memory). */
export const MAX_OPEN_REPORTS = 100;
/** How many causes deep a {@link ReportedError} goes. */
export const MAX_REPORTED_CAUSES = 5;
/** How long shutdown waits for the reporters (ms). */
export const FLUSH_TIMEOUT = 2_000;
/** How long one call of a reporter may take (ms) before it counts as failed and its place is free again. */
export const REPORT_TIMEOUT = 10_000;
/** The least time between two lines that say how many reports were dropped (ms). */
const DROPPED_LOG_INTERVAL = 60_000;

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
const UNPRINTABLE: ReportedError = Object.freeze({ name: 'Error', message: 'Unprintable error', stack: '', code: undefined, status: undefined, cause: undefined });

/** Set while a reporter runs, in everything it starts: an error it reports itself is not reported again. */
const reporting = new AsyncLocalStorage<true>();

/** Whether the code running now was started by an error reporter (or by something it started): what it queues is marked, see `fromReporter`. */
export function startedByReporter(): boolean {
  return reporting.getStore() === true;
}

/**
 * Hands the errors of an app to its reporters: writes the log line, then gives each reporter the masked {@link ErrorReport},
 * on its own, without anyone waiting. A reporter that throws, rejects or hangs costs a warning in the log, never a request;
 * an error a reporter reports itself is dropped. Reporters run outside any transaction. One per app
 * (`app.container.make(ErrorReports)`).
 */
export class ErrorReports {
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #instances = new Map<ErrorReporterClass, ErrorReporter>();
  readonly #open = new Map<ErrorReporterClass, number>();
  /** Calls that ran into the timeout and have not settled: they still hold their report in memory. */
  readonly #abandoned = new Map<ErrorReporterClass, number>();
  readonly #pending = new Set<Promise<unknown>>();
  #dropped = 0;
  readonly #warnedFull = new Set<ErrorReporterClass>();
  #loggedDropped = Number.NEGATIVE_INFINITY;
  #dropSince: number | undefined;

  /**
   * @internal Built by the container.
   *
   * Builds the reporters now, so what their constructors start (timers, sockets) does not belong to the request that happens to report
   * first. One that cannot be built stops the start (K12): reporting silently off is worse. `owners` names the provider of each class.
   */
  constructor(logger: Logger, redactor: Redactor, container: Container, reporters: readonly ErrorReporterClass[] = [], owners: ReadonlyMap<ErrorReporterClass, string> = new Map()) {
    this.#logger = logger;
    this.#redactor = redactor;
    for (const Reporter of new Set(reporters)) {
      try {
        this.#instances.set(Reporter, outsideTransaction(() => container.make(Reporter)));
      } catch (failure) {
        // Neither the message nor the cause: they may carry the value (a DSN) that is wrong.
        // Names are the code's own, but any string: only an identifier is repeated.
        let kind = 'a non-error';
        try {
          if (failure instanceof Error) kind = identifier(String(failure.name), 'Error');
        } catch {
          kind = 'Error';
        }
        const owner = owners.get(Reporter);
        throw new TypeError(withCode('K12', `The error reporter ${identifier(Reporter.name)}${owner === undefined ? '' : ` (static errorReporters of ${identifier(owner)})`} could not be built: its constructor threw ${kind}. Check its constructor and the configuration it reads.`));
      }
    }
  }

  /**
   * Logs the error and passes the masked view to every reporter. Returns at once. `log` is the log line when the caller has a better one
   * than the error's message (`{ message, fields }`, masked here), or `false` when it said the error to the user already. `bindings` are fields of the framework (`job`, `task` …) that a call's context cannot carry: the line is written through a child logger bound with them.
   */
  report(
    error: unknown,
    { source, context = {}, log }: { source: ErrorReport['source']; context?: Readonly<Record<string, string>>; log?: false | { readonly message: string; readonly fields?: LogContext; readonly bindings?: LogContext } },
  ): void {
    // The message is the log line's own text, the stack a string: masked like text by the app's Redactor — keys alone would
    // not catch a connection URL or a token an error quotes, and the core's list alone not the names packages add (the session cookie).
    const { name, message, stack } = asError(error);
    if (log === undefined) this.#logger.error(this.#redactor.text(message), { exception: name, stack: this.#redactor.text(stack) });
    else if (log !== false) (log.bindings ? this.#logger.child(log.bindings) : this.#logger).error(this.#redactor.text(log.message), log.fields);
    if (this.#instances.size === 0 || reporting.getStore()) return;
    const report: ErrorReport = Object.freeze({
      error: this.#reported(error, new Set(), 0),
      source,
      context: Object.freeze(Object.fromEntries(Object.entries(context).map(([key, value]) => [key, this.#redactor.text(value)]))),
    });
    for (const Reporter of this.#instances.keys()) this.#send(Reporter, report);
  }

  /**
   * Asks every reporter to send what it buffers, while the reports in flight finish — at most {@link FLUSH_TIMEOUT} ms in all;
   * never throws.
   * @internal
   */
  async flush(): Promise<void> {
    if (this.#instances.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FLUSH_TIMEOUT);
    });
    const flushing = Promise.all([
      ...this.#pending,
      ...[...this.#instances].map(async ([Reporter, reporter]) => {
        if (!reporter.flush) return;
        try {
          await reporting.run(true, () => outsideTransaction(() => reporter.flush!()));
        } catch (failure) {
          this.#failed(Reporter, failure);
        }
      }),
    ]).then(() => 'done' as const);
    try {
      if ((await Promise.race([flushing, timeout])) === 'timeout') this.#logger.warn(`Error reporters did not finish within ${FLUSH_TIMEOUT} ms of the shutdown; their reports may be lost.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts one reporter on `report`, unless it has too many reports open already. */
  #send(Reporter: ErrorReporterClass, report: ErrorReport): void {
    const open = this.#open.get(Reporter) ?? 0;
    const abandoned = this.#abandoned.get(Reporter) ?? 0;
    // Calls that ran into the timeout still hold their report: they count until they settle, so a stuck reporter holds 100 reports at most.
    if (open + abandoned >= MAX_OPEN_REPORTS) {
      this.#drop(Reporter, abandoned > 0);
      return;
    }
    this.#open.set(Reporter, open + 1);
    const reporter = this.#instances.get(Reporter)!;
    let timer: NodeJS.Timeout | undefined;
    const call = reporting.run(true, () => outsideTransaction(() => Promise.resolve().then(() => reporter.report(report))));
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.#abandoned.set(Reporter, (this.#abandoned.get(Reporter) ?? 0) + 1);
        reject(new Error(`did not finish within ${REPORT_TIMEOUT} ms`));
      }, REPORT_TIMEOUT);
      timer.unref();
    });
    call
      .catch(() => {})
      .finally(() => {
        if (timedOut) this.#abandoned.set(Reporter, (this.#abandoned.get(Reporter) ?? 1) - 1);
        this.#released(Reporter);
      });
    const done: Promise<unknown> = Promise.race([call, timeout])
      .catch((failure: unknown) => this.#failed(Reporter, failure))
      .finally(() => {
        clearTimeout(timer);
        this.#open.set(Reporter, (this.#open.get(Reporter) ?? 1) - 1);
        this.#released(Reporter);
        this.#pending.delete(done);
        if (this.#pending.size === 0) this.#drained();
      });
    this.#pending.add(done);
  }

  /** A report one reporter has no place for: counted, and said once per reporter; the sum follows at most once a minute, flood or not. */
  #drop(Reporter: ErrorReporterClass, stuck: boolean): void {
    this.#dropped++;
    if (!this.#warnedFull.has(Reporter)) {
      this.#warnedFull.add(Reporter);
      this.#logger.warn(
        stuck
          ? `Error reporter ${identifier(Reporter.name)} has calls that never finished: it gets no further reports until they do.`
          : `Error reporter ${identifier(Reporter.name)} has ${MAX_OPEN_REPORTS} reports open: it is slow or stuck, further reports to it are dropped.`,
      );
    }
    const now = Date.now();
    this.#dropSince ??= now;
    if (now - this.#dropSince >= DROPPED_LOG_INTERVAL) this.#logDropped(now);
  }

  /** A reporter with nothing open and nothing abandoned is trusted again: its next full circuit is said again. */
  #released(Reporter: ErrorReporterClass): void {
    if ((this.#open.get(Reporter) ?? 0) + (this.#abandoned.get(Reporter) ?? 0) === 0) this.#warnedFull.delete(Reporter);
  }

  /** Nothing is open any more: say how many reports were dropped meanwhile — at most once a minute. */
  #drained(): void {
    const now = Date.now();
    if (this.#dropped > 0 && now - this.#loggedDropped >= DROPPED_LOG_INTERVAL) this.#logDropped(now);
  }

  #logDropped(now: number): void {
    const stuck = [...this.#warnedFull].map((Reporter) => identifier(Reporter.name)).join(', ');
    this.#logger.warn(`${this.#dropped} error reports were dropped because a reporter had too many open${stuck ? ` (${stuck})` : ''}.`);
    this.#dropped = 0;
    this.#dropSince = undefined;
    this.#loggedDropped = now;
  }

  /** Once per failing report: the reporter's own failure is never reported again. */
  #failed(Reporter: ErrorReporterClass, failure: unknown): void {
    const { name, message } = asError(failure);
    this.#logger.warn(`Error reporter ${identifier(Reporter.name)} failed: ${this.#redactor.text(message)}`, { exception: name });
  }

  /** The masked, frozen view of `error`; `seen` stops a cause that leads back to an error already shown. */
  #reported(error: unknown, seen: Set<unknown>, depth: number): ReportedError {
    try {
      const { name, message, stack } = asError(error);
      seen.add(error);
      const object = typeof error === 'object' && error !== null ? error : undefined;
      const code = read(object, 'code');
      const status = read(object, 'status');
      const cause = read(object, 'cause');
      const maskedName = this.#redactor.text(name);
      return Object.freeze({
        name: IDENTIFIER.test(maskedName) ? maskedName : 'Error',
        message: this.#redactor.text(message),
        stack: this.#redactor.text(stack),
        code: typeof code === 'string' || typeof code === 'number' ? this.#redactor.text(String(code)) : undefined,
        status: typeof status === 'number' ? status : undefined,
        cause: cause === undefined || cause === null || seen.has(cause) || depth >= MAX_REPORTED_CAUSES ? undefined : this.#reported(cause, seen, depth + 1),
      });
    } catch {
      return UNPRINTABLE;
    }
  }
}

/** `text` when it is an identifier, else `fallback`: a name that reaches a log line or a start message. */
function identifier(text: string, fallback = '(anonymous)'): string {
  return IDENTIFIER.test(text) ? text : fallback;
}

/** A property of an error, which may be a getter that throws. */
function read(object: object | undefined, key: string): unknown {
  try {
    return object === undefined ? undefined : (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function asError(error: unknown): { name: string; message: string; stack: string } {
  try {
    if (error instanceof Error) return { name: String(error.name), message: String(error.message), stack: String(error.stack ?? '') };
    return { name: 'Error', message: String(error), stack: '' };
  } catch {
    return { name: 'Error', message: 'Unprintable error', stack: '' };
  }
}
