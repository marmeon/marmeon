import { Application, currentLogContext, defineConfig, env, environment, escapeControls, Logger, Redactor, type ConfigOf, type Container, type LogContext, type ServiceProvider } from '@marmeon/core';
import { logContextSourcesOf, messageBase } from '@marmeon/core/internal';
import { channels } from '@marmeon/core/diagnostics';
import { createRequire } from 'node:module';
import { pino, type Logger as Pino } from 'pino';
import type pinoPretty from 'pino-pretty';

export const LogConfig = defineConfig('log', {
  env: env({
    LOG_LEVEL: env.in(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    /**
     * `pretty` for humans, `json` for log shippers. Defaults to pretty with `NODE_ENV=development` only — JSON everywhere else,
     * also without a `NODE_ENV`.
     */
    LOG_FORMAT: env.in(['pretty', 'json']).optional(),
    NODE_ENV: env.string().optional(),
    APP_ENV: env.string().optional(),
  }),
  resolve: (e) => ({
    level: e.LOG_LEVEL,
    format: e.LOG_FORMAT ?? (environment.isDevelopment(e) ? 'pretty' : 'json'),
    /** `APP_ENV` (`staging`, `production`, …; by default the one `NODE_ENV` goes with): the `appEnv` field of every JSON entry. */
    environment: environment.app(e),
  }),
});
export type LogConfig = ConfigOf<typeof LogConfig>;

/** What `createPinoLogger` needs: the level, the format — and the app's environment, written as `appEnv` into every entry. */
export interface LogOptions {
  readonly level: LogConfig['level'];
  readonly format: LogConfig['format'];
  readonly environment?: string | undefined;
}

const entries = channels.event('log');

/**
 * Adapts pino to the framework's Logger contract (`message, context` order). With an `app`, every entry also
 * goes to the `log` channel — at any level, before pino's level filter — while something listens; otherwise the
 * path is pino's alone. A subscriber of `log` must not log itself.
 */
export class PinoLogger implements Logger {
  readonly #pino: Pino;
  readonly #app: Application | undefined;
  /** This logger's own bindings — with its parent's, only computed for a message on the channel. */
  readonly #bindings: LogContext | undefined;
  readonly #parent: PinoLogger | undefined;
  /** The app's `Redactor` (its packages add names to it), or one of the core's key list without an app. */
  readonly #redactor: Redactor;

  constructor(logger: Pino, app?: Application, bindings?: LogContext, parent?: PinoLogger) {
    this.#pino = logger;
    this.#app = app;
    this.#bindings = bindings;
    this.#parent = parent;
    this.#redactor = parent ? parent.#redactor : redactorOf(app);
  }

  debug(message: string, context?: LogContext): void {
    this.#pino.debug(context ?? {}, message);
    if (this.#app && entries.hasSubscribers) this.#publish('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.#pino.info(context ?? {}, message);
    if (this.#app && entries.hasSubscribers) this.#publish('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.#pino.warn(context ?? {}, message);
    if (this.#app && entries.hasSubscribers) this.#publish('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.#pino.error(context ?? {}, message);
    if (this.#app && entries.hasSubscribers) this.#publish('error', message, context);
  }
  /** Written at this level (pino's own check) — or listened to on the `log` channel, which sees every level. */
  enabled(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    return this.#pino.isLevelEnabled(level) || (this.#app !== undefined && entries.hasSubscribers);
  }
  child(bindings: LogContext): Logger {
    // pino writes a child's bindings once, at creation, past `formatters.log` — so they are redacted here.
    return new PinoLogger(this.#pino.child(this.#redactor.log(bindings)), this.#app, bindings, this);
  }

  #publish(level: 'debug' | 'info' | 'warn' | 'error', message: string, context: LogContext | undefined): void {
    entries.publish({ ...messageBase(this.#app!), level, message, context: { ...this.#allBindings(), ...context } });
  }

  #allBindings(): LogContext {
    return this.#parent ? { ...this.#parent.#allBindings(), ...this.#bindings } : { ...this.#bindings };
  }
}

// The redaction lives in core: the queue redacts a failed job's error the same way.
export { redact, REDACTED_KEYS } from '@marmeon/core';

/** The app's `Redactor` — one per app, with the names its packages add (the session's cookie) — or the core's key list alone. */
function redactorOf(app: Application | undefined): Redactor {
  return app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();
}

/** The log context without the keys `instance` (a child logger) is bound with — each key once in a JSON line. */
function withoutBound(context: Readonly<Record<string, unknown>>, instance: unknown): Readonly<Record<string, unknown>> {
  const keys = Object.keys(context);
  if (keys.length === 0) return context;
  const bound = (instance as { bindings?: () => Record<string, unknown> }).bindings?.() ?? {};
  return keys.some((key) => key in bound) ? Object.fromEntries(Object.entries(context).filter(([key]) => !(key in bound))) : context;
}

/**
 * pino-pretty, loaded when a logger is pretty — in development. JSON logs (production, tests, workers) never load
 * its 28 modules. Synchronous (`require`), because the logger is made synchronously.
 */
function pretty(): typeof pinoPretty {
  return createRequire(import.meta.url)('pino-pretty') as typeof pinoPretty;
}

/**
 * A log context for a terminal: the `message` and `stack` of errors (at any depth) with control characters written out, so
 * neither forges a line nor passes an escape sequence. A stack keeps the line breaks that start its own frames.
 */
function terminalSafe(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'stack') return value.split('\n    at ').map((piece) => escapeControls(piece)).join('\n    at ');
    return key === 'message' ? escapeControls(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => terminalSafe(item));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, terminalSafe(entry, name)]));
  }
  return value;
}

/** `app`: its entries also go to the `log` channel while something listens. */
export function createPinoLogger(config: LogOptions, destination?: NodeJS.WritableStream, app?: Application): Logger {
  const stream =
    destination ?? (config.format === 'pretty' ? pretty()({ colorize: true, sync: true, ignore: 'pid,hostname,appEnv' }) : undefined);
  // What the app's packages add to every entry (@marmeon/otel: `trace_id`, `span_id`) — nothing to merge without a source.
  const sources = logContextSourcesOf(app);
  const redactor = redactorOf(app);
  const logger = pino(
    {
      level: config.level,
      // The app's environment on every entry (`APP_ENV`, informative) — a log shipper tells one deployment from another by it.
      base: config.environment === undefined ? undefined : { appEnv: config.environment },
      // The app's Redactor: sensitive keys at any depth, an error under any key as type, message and stack, masked.
      formatters: { log: (object) => (config.format === 'pretty' ? terminalSafe(redactor.log(object)) : redactor.log(object)) as Record<string, unknown> },
      // A line break in a message must not start a line of its own in the terminal (pino-pretty prints it as it is): JSON
      // escapes it already.
      hooks: {
        logMethod(args, method) {
          if (config.format === 'pretty' && typeof args[1] === 'string') args[1] = escapeControls(args[1]);
          method.apply(this, args);
        },
      },
      // The redaction wrote `err` already, in the shape of pino's error serializer — which would take it for an object of its own.
      serializers: { err: (value: unknown) => value },
      // Every entry written while a request is handled carries its id; while a job runs, the job's name, id and attempt; and
      // what the app's log context sources add (the active span's ids).
      // A key a child logger is bound with already (the scheduler's `task`) is left out: pino would write it twice.
      mixin: (_merge, _level, instance) => {
        const added = sources?.current();
        return withoutBound(added ? { ...currentLogContext(), ...added } : currentLogContext(), instance);
      },
    },
    stream as never,
  );
  return new PinoLogger(logger, app);
}

/** Found by `marmeon discover` through the "marmeon" field in package.json. */
export class LogServiceProvider implements ServiceProvider {
  static config = [LogConfig];

  register(container: Container): void {
    container.singleton(Logger, (c) => createPinoLogger(c.make(LogConfig), undefined, c.make(Application)));
  }
}
