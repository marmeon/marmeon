import type { Application } from './application.ts';
import { channels, messageBase } from './diagnostics.ts';
import { currentLogContext } from './request-context.ts';
import { token } from './token.ts';

export type LogContext = Readonly<Record<string, unknown>>;

/**
 * The logging contract. Packages depend on this, never on a logging library;
 * `@bespokecore/log` binds a pino implementation, and without it the
 * {@link ConsoleLogger} fallback is used.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that adds `bindings` to every entry, e.g. `{ channel: 'http' }`. */
  child(bindings: LogContext): Logger;
}
export const Logger = token<Logger>('Logger');

const entries = channels.event('log');

/**
 * Minimal fallback: one line per entry on stderr/stdout, the request's id or the job's name, id and attempt included.
 * With an `app`, entries also go to the `log` channel (E118) while something listens.
 */
export class ConsoleLogger implements Logger {
  readonly #bindings: LogContext;
  readonly #app: Application | undefined;

  constructor(bindings: LogContext = {}, app?: Application) {
    this.#bindings = bindings;
    this.#app = app;
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
    return new ConsoleLogger({ ...this.#bindings, ...bindings }, this.#app);
  }

  #write(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: LogContext): void {
    if (this.#app && entries.hasSubscribers) entries.publish({ ...messageBase(this.#app), level, message, context: { ...this.#bindings, ...context } });
    const data = { ...this.#bindings, ...currentLogContext(), ...context };
    const line = `[${level}] ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
}
