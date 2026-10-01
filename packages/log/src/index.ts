import { currentRequest, defineConfig, Logger, type ConfigOf, type Container, type LogContext, type ServiceProvider } from '@bespokecore/core';
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

/** Adapts pino to the framework's Logger contract (`message, context` order, like Laravel). */
export class PinoLogger implements Logger {
  readonly #pino: Pino;

  constructor(logger: Pino) {
    this.#pino = logger;
  }

  debug(message: string, context?: LogContext): void {
    this.#pino.debug(context ?? {}, message);
  }
  info(message: string, context?: LogContext): void {
    this.#pino.info(context ?? {}, message);
  }
  warn(message: string, context?: LogContext): void {
    this.#pino.warn(context ?? {}, message);
  }
  error(message: string, context?: LogContext): void {
    this.#pino.error(context ?? {}, message);
  }
  child(bindings: LogContext): Logger {
    return new PinoLogger(this.#pino.child(bindings));
  }
}

/** Context keys whose values never reach the log: passwords, tokens, secrets, credentials and cookies. */
export const REDACTED_KEYS = /pass(word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature/i;

/**
 * A copy of `context` with sensitive values replaced by `[redacted]` — by key, at any depth (`password`,
 * `new_password`, `headers.authorization`, `remember_web` …). Messages themselves are not scanned:
 * never put secrets into a log message. Query parameters stay out of the query log anyway.
 */
export function redact(context: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACTED_KEYS.test(key)) out[key] = '[redacted]';
    else if (depth < 6 && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error)) out[key] = redact(value as Record<string, unknown>, depth + 1);
    else out[key] = value;
  }
  return out;
}

export function createPinoLogger(config: LogConfig, destination?: NodeJS.WritableStream): Logger {
  const stream =
    destination ?? (config.format === 'pretty' ? pretty({ colorize: true, sync: true, ignore: 'pid,hostname' }) : undefined);
  const logger = pino(
    {
      level: config.level,
      base: undefined,
      formatters: { log: (object) => redact(object) },
      // Every entry written while a request is handled carries its id.
      mixin: () => {
        const requestId = currentRequest()?.requestId;
        return requestId ? { requestId } : {};
      },
    },
    stream as never,
  );
  return new PinoLogger(logger);
}

/** Found by `bespoke discover` through the "bespoke" field in package.json. */
export class LogServiceProvider implements ServiceProvider {
  static config = [LogConfig];

  register(container: Container): void {
    container.singleton(Logger, (c) => createPinoLogger(c.make(LogConfig)));
  }
}
