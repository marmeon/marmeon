import { Application, currentLogContext, defineConfig, logContextSourcesOf, redact, Logger, type ConfigOf, type Container, type LogContext, type ServiceProvider } from '@bespokecore/core';
import { channels, messageBase } from '@bespokecore/core/diagnostics';
import { pino, type Logger as Pino } from 'pino';
import pretty from 'pino-pretty';
import * as v from 'valibot';

export const LogConfig = defineConfig('log', {
  env: v.object({
    LOG_LEVEL: v.optional(v.picklist(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']), 'info'),
    /** `pretty` for humans, `json` for log shippers. Defaults to pretty outside production. */
    LOG_FORMAT: v.optional(v.picklist(['pretty', 'json'])),
    NODE_ENV: v.optional(v.string()),
  }),
  resolve: (env) => ({
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  }),
});
export type LogConfig = ConfigOf<typeof LogConfig>;

const entries = channels.event('log');

/**
 * Adapts pino to the framework's Logger contract (`message, context` order, like Laravel). With an `app`, every entry also
 * goes to the `log` channel (E118) — at any level, before pino's level filter — while something listens; otherwise the
 * path is pino's alone. A subscriber of `log` must not log itself.
 */
export class PinoLogger implements Logger {
  readonly #pino: Pino;
  readonly #app: Application | undefined;
  /** This logger's own bindings — with its parent's, only computed for a message on the channel. */
  readonly #bindings: LogContext | undefined;
  readonly #parent: PinoLogger | undefined;

  constructor(logger: Pino, app?: Application, bindings?: LogContext, parent?: PinoLogger) {
    this.#pino = logger;
    this.#app = app;
    this.#bindings = bindings;
    this.#parent = parent;
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
  child(bindings: LogContext): Logger {
    return new PinoLogger(this.#pino.child(bindings), this.#app, bindings, this);
  }

  #publish(level: 'debug' | 'info' | 'warn' | 'error', message: string, context: LogContext | undefined): void {
    entries.publish({ ...messageBase(this.#app!), level, message, context: { ...this.#allBindings(), ...context } });
  }

  #allBindings(): LogContext {
    return this.#parent ? { ...this.#parent.#allBindings(), ...this.#bindings } : { ...this.#bindings };
  }
}

// The redaction lives in core: the queue redacts a failed job's error the same way (E105).
export { redact, REDACTED_KEYS } from '@bespokecore/core';

/** The log context without the keys `instance` (a child logger) is bound with — each key once in a JSON line. */
function withoutBound(context: Readonly<Record<string, unknown>>, instance: unknown): Readonly<Record<string, unknown>> {
  const keys = Object.keys(context);
  if (keys.length === 0) return context;
  const bound = (instance as { bindings?: () => Record<string, unknown> }).bindings?.() ?? {};
  return keys.some((key) => key in bound) ? Object.fromEntries(Object.entries(context).filter(([key]) => !(key in bound))) : context;
}

/** `app`: its entries also go to the `log` channel (E118) while something listens. */
export function createPinoLogger(config: LogConfig, destination?: NodeJS.WritableStream, app?: Application): Logger {
  const stream =
    destination ?? (config.format === 'pretty' ? pretty({ colorize: true, sync: true, ignore: 'pid,hostname' }) : undefined);
  // What the app's packages add to every entry (@bespokecore/otel: `trace_id`, `span_id`) — nothing to merge without a source.
  const sources = logContextSourcesOf(app);
  const logger = pino(
    {
      level: config.level,
      base: undefined,
      formatters: { log: (object) => redact(object) },
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

/** Found by `bespoke discover` through the "bespoke" field in package.json. */
export class LogServiceProvider implements ServiceProvider {
  static config = [LogConfig];

  register(container: Container): void {
    container.singleton(Logger, (c) => createPinoLogger(c.make(LogConfig), undefined, c.make(Application)));
  }
}
