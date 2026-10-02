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

/** Minimal fallback: one line per entry on stderr/stdout, the request's id or the job's name, id and attempt included. */
export class ConsoleLogger implements Logger {
  readonly #bindings: LogContext;

  constructor(bindings: LogContext = {}) {
    this.#bindings = bindings;
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
    return new ConsoleLogger({ ...this.#bindings, ...bindings });
  }

  #write(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: LogContext): void {
    const data = { ...this.#bindings, ...currentLogContext(), ...context };
    const line = `[${level}] ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
}
