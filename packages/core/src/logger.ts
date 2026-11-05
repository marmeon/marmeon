import type { Application } from './application.ts';
import { channels, messageBase } from './channels.ts';
import { Redactor } from './redact.ts';
import { currentLogContext } from './request-context.ts';
import { token } from './token.ts';

export type LogContext = Readonly<Record<string, unknown>>;

/**
 * The logging contract. Packages depend on this, never on a logging library;
 * `@marmeon/log` binds a pino implementation, and without it the
 * {@link ConsoleLogger} fallback is used.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that adds `bindings` to every entry, e.g. `{ channel: 'http' }`. */
  child(bindings: LogContext): Logger;
  /**
   * Whether an entry at `level` would go anywhere — written (the configured level lets it through) or seen on the `log` channel.
   * A caller asks before it builds an entry that costs something (the request line with its redacted path): with
   * `LOG_LEVEL=silent` nothing is built. Optional — a logger without it counts as enabled.
   */
  enabled?(level: 'debug' | 'info' | 'warn' | 'error'): boolean;
}
export const Logger = token<Logger>('Logger');

const entries = channels.event('log');

/**
 * The fields of a JSON log line that carry the framework's own values (docs/logging.md#the-fields-of-a-json-line). A key of a call's context with one of
 * these names is written as `context.<key>`, so logged data cannot forge a level, a request id or a trace. The bindings of a
 * child logger are the developer's own and are not renamed.
 * @internal
 */
export const FRAMEWORK_LOG_FIELDS: ReadonlySet<string> = new Set([
  'level', 'time', 'msg', 'appEnv', 'requestId', 'job', 'jobId', 'attempt', 'task', 'trace_id', 'span_id', 'trace_flags',
]);

/** `context` with its keys that name a {@link FRAMEWORK_LOG_FIELDS} entry written as `context.<key>`; `context` itself when none does. @internal */
export function withoutFrameworkFields(context: LogContext): LogContext {
  let renamed: Record<string, unknown> | undefined;
  for (const key of Object.keys(context)) {
    if (!FRAMEWORK_LOG_FIELDS.has(key)) continue;
    renamed ??= { ...context };
    delete renamed[key];
    // A `context.<key>` the caller wrote itself stays: the value under the framework's name is dropped, never written as the field.
    if (!(`context.${key}` in context)) renamed[`context.${key}`] = context[key];
  }
  return renamed ?? context;
}

/**
 * More fields for every log entry written now — beside the request's id or the job's name (`currentLogContext()`). One per
 * app; `@marmeon/otel` adds the active span's `trace_id` and `span_id`. A source runs for every entry: keep it cheap, and
 * return nothing when it has nothing to add.
 */
export class LogContextSources {
  readonly #sources = new Set<() => LogContext | undefined>();

  /** Adds a source; returns a function that removes it (a provider's `shutdown()`). */
  add(source: () => LogContext | undefined): () => void {
    this.#sources.add(source);
    return () => {
      this.#sources.delete(source);
    };
  }

  /** The fields each source adds now, one entry per source that adds any — for a reader that judges every part on its own. @internal */
  parts(): LogContext[] {
    const parts: LogContext[] = [];
    for (const source of this.#sources) {
      try {
        const fields = source();
        if (fields) parts.push(fields);
      } catch {
        // A source must never cost a log entry.
      }
    }
    return parts;
  }

  /** What the sources add now — `undefined` when none adds anything (the common case: no source at all). */
  current(): LogContext | undefined {
    if (this.#sources.size === 0) return undefined;
    let merged: Record<string, unknown> | undefined;
    for (const source of this.#sources) {
      let fields: LogContext | undefined;
      try {
        fields = source();
        if (fields) merged = { ...merged, ...fields };
      } catch {
        // A source must never cost a log entry (nor may a getter of what it returns).
      }
    }
    return merged;
  }
}

/** The log context sources of `app` (bound by `createApplication`), if any. */
export function logContextSourcesOf(app: Application | undefined): LogContextSources | undefined {
  return app?.container.has(LogContextSources) ? app.container.make(LogContextSources) : undefined;
}

/**
 * `line` with every control, format and line-separator character written out (`\n`, `\r`, `\u001b`), so a decoded newline in a
 * message cannot start a line of its own. Use it in an app's own logger that writes lines.
 */
function codePointOf(char: string): string {
  const code = char.codePointAt(0)!;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

export function escapeControls(line: string): string {
  return line.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    char === '\n' ? '\\n' : char === '\r' ? '\\r' : codePointOf(char),
  );
}

let everythingToStderr = false;

/**
 * Makes every {@link ConsoleLogger} line go to stderr, whatever its level: the CLI does it for a command that prints JSON,
 * whose stdout holds the document and nothing else.
 * @internal Only for the CLI; not part of the public API.
 */
export function sendConsoleLogsToStderr(enabled = true): void {
  everythingToStderr = enabled;
}

/** Whether {@link sendConsoleLogsToStderr} is on: a logging package writes to stderr (fd 2) instead of stdout then. @internal */
export function consoleLogsGoToStderr(): boolean {
  return everythingToStderr;
}

/**
 * An entry's data as JSON. A `bigint` (a driver's error field or cause) is written as its digits. The redactor cuts cycles
 * (error causes, depth), so what can still throw is code of the app's own in the logged data — a `toJSON` or a getter.
 */
function serialize(data: Record<string, unknown>): string {
  return JSON.stringify(data, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
}

/** Written in place of a part of an entry that could not be read. A constant, never the error: its message may quote the value that failed. @internal */
export const UNREADABLE_PART: Readonly<Record<string, unknown>> = Object.freeze({ context: '[unserializable]' });

/**
 * One part of an entry (the call's context, the request's or job's, one source's fields, a logger's bindings) redacted — or
 * `undefined` when reading it throws (a getter of the app's own). Every part is judged on its own, so a failing one costs only
 * itself. With `probe`, writing it as JSON must work too (a `toJSON` that throws): for a logger that serializes itself, where a
 * failed write would otherwise cost the whole entry; pino replaces just the one value, so its parts are not probed. @internal
 */
export function redactedLogPart(redactor: Redactor, part: LogContext, probe = false): Record<string, unknown> | undefined {
  try {
    const redacted = redactor.log(part);
    if (probe) serialize(redacted);
    return redacted;
  } catch {
    return undefined;
  }
}

/** The request's or job's context and the fields of each log context source of `app`, each part redacted on its own ({@link redactedLogPart}). @internal */
export function redactedFrameworkFields(redactor: Redactor, app: Application | undefined, probe = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(redactedLogPart(redactor, currentLogContext(), probe) ?? UNREADABLE_PART) };
  const sources = logContextSourcesOf(app);
  if (sources) for (const part of sources.parts()) Object.assign(out, redactedLogPart(redactor, part, probe) ?? UNREADABLE_PART);
  return out;
}

/**
 * Minimal fallback: one line per entry on stderr/stdout, the request's id or the job's name, id and attempt included.
 * With an `app`, entries also go to the `log` channel while something listens, and are redacted by the app's
 * `Redactor` (the names its packages add count too).
 */
export class ConsoleLogger implements Logger {
  readonly #bindings: LogContext;
  readonly #app: Application | undefined;
  readonly #redactor: Redactor;

  /** @internal Built by the container. */
  constructor(bindings: LogContext = {}, app?: Application) {
    this.#bindings = bindings;
    this.#app = app;
    this.#redactor = app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();
  }

  debug(message: string, context?: LogContext): void {
    this.#write('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.#write('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.#write('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.#write('error', message, context);
  }
  child(bindings: LogContext): Logger {
    // Read once, here: a getter or `toJSON` of the app's own that throws must not fail every later log call of the child.
    let merged: LogContext | undefined;
    try {
      merged = { ...this.#bindings, ...bindings };
    } catch {
      merged = undefined;
    }
    if (merged === undefined || redactedLogPart(this.#redactor, merged, true) === undefined) merged = { ...this.#bindings, ...UNREADABLE_PART };
    return new ConsoleLogger(merged, this.#app);
  }

  #write(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: LogContext): void {
    // A getter of the app's own that throws must not turn a log call — often inside cleanup — into a failure.
    if (this.#app && entries.hasSubscribers) {
      try {
        entries.publish({ ...messageBase(this.#app), level, message, context: { ...this.#bindings, ...context } });
      } catch {
        // The entry is still written below.
      }
    }
    // Each part is judged on its own, so a failing one costs only itself and the framework's (the request's id, the task) stay on
    // the line. The call's context is redacted before its framework-named keys are renamed: a name the app redacts (`msg`) is
    // judged as written. Written once; only when that fails are the parts probed one by one.
    const parts = (probe: boolean): Record<string, unknown> => ({
      ...withoutFrameworkFields(redactedLogPart(this.#redactor, context ?? {}, probe) ?? { ...UNREADABLE_PART }),
      ...redactedFrameworkFields(this.#redactor, this.#app, probe),
      ...(redactedLogPart(this.#redactor, this.#bindings, probe) ?? UNREADABLE_PART),
    });
    let json: string;
    try {
      json = serialize(parts(false));
    } catch {
      try {
        json = serialize(parts(true));
      } catch {
        json = serialize({ ...UNREADABLE_PART });
      }
    }
    const line = escapeControls(`[${level}] ${message}${json === '{}' ? '' : ` ${json}`}`);
    (everythingToStderr || level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
}
