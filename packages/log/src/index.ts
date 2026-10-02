import { currentLogContext, defineConfig, redact, Logger, type ConfigOf, type Container, type LogContext, type ServiceProvider } from '@bespokecore/core';
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

// The redaction lives in core: the queue redacts a failed job's error the same way (E105).
export { redact, REDACTED_KEYS } from '@bespokecore/core';

export function createPinoLogger(config: LogConfig, destination?: NodeJS.WritableStream): Logger {
  const stream =
    destination ?? (config.format === 'pretty' ? pretty({ colorize: true, sync: true, ignore: 'pid,hostname' }) : undefined);
  const logger = pino(
    {
      level: config.level,
      base: undefined,
      formatters: { log: (object) => redact(object) },
      // Every entry written while a request is handled carries its id; while a job runs, the job's name, id and attempt.
      mixin: () => currentLogContext(),
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
