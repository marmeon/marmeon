import { Application, defineConfig, env, environment, escapeControls, Logger, Redactor, type ConfigOf, type Container, type LogContext, type ServiceProvider } from '@marmeon/core';
import { consoleLogsGoToStderr, messageBase, redactedFrameworkFields, redactedLogPart, UNREADABLE_PART, withoutFrameworkFields } from '@marmeon/core/internal';
import { channels } from '@marmeon/core/diagnostics';
import { createRequire } from 'node:module';
import { writeSync } from 'node:fs';
import { destination as pinoDestination, pino, type DestinationStream, type Logger as Pino } from 'pino';
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
class PinoLogger implements Logger {
  readonly #pino: Pino;
  readonly #app: Application | undefined;
  /** This logger's own bindings — with its parent's, only computed for a message on the channel. */
  readonly #bindings: LogContext | undefined;
  readonly #parent: PinoLogger | undefined;
  /** The app's `Redactor` (its packages add names to it), or one of the core's key list without an app. */
  readonly #redactor: Redactor;

  /** Pretty-printed to a terminal: the bindings of a child are escaped. */
  readonly #terminal: boolean;

  constructor(logger: Pino, app?: Application, bindings?: LogContext, parent?: PinoLogger, terminal = false) {
    this.#terminal = terminal;
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
    // pino writes a child's bindings once, at creation, past `formatters.log` and `formatters.bindings` (it resets the latter for
    // a child) — so they are redacted, renamed and, for a terminal, escaped here, in this order: a name the app redacts (`msg`)
    // is judged as written.
    // A binding that names a field pino or this logger writes itself (`time`, `level`, `msg`, `appEnv`) would be written a second
    // time, and parsers take the last one — it becomes `context.<key>`, as in the context of a call.
    // A getter of the app's own that throws: the child is bound with a constant, never with the error.
    const redacted = Object.fromEntries(Object.entries(redactedLogPart(this.#redactor, bindings) ?? UNREADABLE_PART).map(([key, value]) => [PINO_OWN_FIELDS.has(key) ? `context.${key}` : key, value]));
    return new PinoLogger(this.#pino.child(this.#terminal ? terminalSafeEntry(redacted) : redacted), this.#app, bindings, this, this.#terminal);
  }

  #publish(level: 'debug' | 'info' | 'warn' | 'error', message: string, context: LogContext | undefined): void {
    try {
      entries.publish({ ...messageBase(this.#app!), level, message, context: { ...this.#allBindings(), ...context } });
    } catch {
      // A getter of the app's own that throws: the entry is written already.
    }
  }

  #allBindings(): LogContext {
    return this.#parent ? { ...this.#parent.#allBindings(), ...this.#bindings } : { ...this.#bindings };
  }
}

/** The fields pino writes itself, and `appEnv` (its `base`): no child binding may repeat them. */
const PINO_OWN_FIELDS: ReadonlySet<string> = new Set(['level', 'time', 'msg', 'appEnv']);

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
 * neither forges a line nor passes an escape sequence. A stack keeps the line breaks that start its own frames. Values
 * below the top level go through `JSON.stringify` in pino-pretty, which escapes them.
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

/**
 * The top level of an entry or of a child's bindings for a terminal: pino-pretty prints every top-level string (`name`,
 * `caller`, …) and every key as it is, line breaks included. Each is written out here, whatever its name; the rest is
 * `terminalSafe`. Two keys that are equal after escaping collapse into the one entered later.
 */
function terminalSafeEntry(object: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [escapeControls(key), typeof value === 'string' && key !== 'stack' ? escapeControls(value) : terminalSafe(value, key)]));
}

/**
 * The most bytes the asynchronous destination (the default: JSON on stdout) keeps while the descriptor does not take them (a pipe nobody reads);
 * a line beyond it is dropped, so a stalled reader costs a bounded amount of memory. 4 MiB is a few thousand lines of a server
 * that logs much, and small beside what a process holds anyway.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * How often in a row the exit flush waits 100 ms for a full pipe before it drops the rest (the pipe takes no byte for that
 * long), and how long in all it waits (a reader that takes a small burst now and then must not hold the exit). Both bound pipes
 * only: a terminal that stops reading (Ctrl-S, a stalled ssh session) is a blocking descriptor, whose `write` no Node API
 * can limit.
 */
const MAX_EXIT_WAITS = 20;
const MAX_EXIT_MILLISECONDS = 5_000;

/**
 * The fields of sonic-boom 4 (4.2.1 in this repo's lockfile; pino only asks for `^4.0.1`) that `drainSync` reads and the dying
 * destination clears. A different shape is treated as a failed flush.
 */
interface SonicState {
  _bufs: string[];
  _writingBuf: string | Buffer;
  _writing: boolean;
  _len: number;
}

type Sonic = ReturnType<typeof pinoDestination>;

function hasSonicState(sonic: Sonic): sonic is Sonic & SonicState {
  const state = sonic as unknown as Partial<SonicState>;
  return (
    Array.isArray(state._bufs) &&
    state._bufs.every((chunk) => typeof chunk === 'string') &&
    (typeof state._writingBuf === 'string' || Buffer.isBuffer(state._writingBuf)) &&
    typeof state._writing === 'boolean' &&
    typeof state._len === 'number'
  );
}

/** The exit flush failed without an OS error (see `drainSync`). */
const FLUSH_FAILED = 'flush failed';

/** Waits without the event loop, as sonic-boom does while a descriptor says `EAGAIN`. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * `flushSync` of sonic-boom for the exit hook, whose own loop retries a write that fails with any code for ever (a process whose
 * stdout is gone, or whose reader never reads, would never end). Here `EAGAIN` and `EBUSY` (a full pipe) are waited out up to
 * `MAX_EXIT_WAITS` times in a row (a write that takes bytes starts the count again) and `MAX_EXIT_MILLISECONDS` in all; any other
 * error, or the last of those, is returned and the rest is dropped. `FLUSH_FAILED` is this logger's own result for a flush that
 * failed without an OS error (an unexpected sonic-boom shape, or a throw): it has no errno.
 */
function drainSync(sonic: Sonic, fd: number, retrying: boolean): NodeJS.ErrnoException | typeof FLUSH_FAILED | undefined {
  if (!hasSonicState(sonic)) return FLUSH_FAILED;
  // A write in flight is left to finish (as sonic-boom does). One that waits for its retry after `EAGAIN` is not in flight: its
  // timer never fires after `'exit'`, and `_writingBuf` holds exactly what is still to write.
  const inFlight = sonic._writing && !retrying;
  const head = inFlight ? [] : [Buffer.from(sonic._writingBuf)];
  let rest = Buffer.concat([...head, ...sonic._bufs.map((chunk) => Buffer.from(chunk))]);
  sonic._bufs = [];
  sonic._writingBuf = inFlight ? sonic._writingBuf : '';
  sonic._len = inFlight ? Buffer.byteLength(sonic._writingBuf) : 0;
  const deadline = performance.now() + MAX_EXIT_MILLISECONDS;
  let waits = 0;
  while (rest.length > 0) {
    try {
      rest = rest.subarray(writeSync(fd, rest));
      waits = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EAGAIN' && code !== 'EBUSY') || waits === MAX_EXIT_WAITS || performance.now() >= deadline) return error as NodeJS.ErrnoException;
      waits += 1;
      sleepSync(100);
    }
  }
  return undefined;
}

/**
 * A destination on `fd` that a failed write cannot turn into a thrown error, an uncaught `'error'` event or a process that never
 * ends. Any error but `EAGAIN` (`ENOSPC`, `EIO`, `EBADF`, `EPIPE`) ends the destination for good: it drops what it holds and
 * every line after, and retries nothing. A failed stdout (not a reader that left: `EPIPE`) is told once on stderr (dropped when
 * stderr is a full pipe); a failed stderr is not told anywhere, because stdout may hold a command's document.
 *
 * Asynchronous (`sync` false), as the default destination is: `EAGAIN` (a full pipe) is backpressure, sonic-boom keeps the data up
 * to `MAX_BUFFERED_BYTES` and `write` returns at once. Synchronous (`--json`, `marmeon mcp`, pretty), the buffer has no bound:
 * `write` returns once the line is written, and while the pipe is full it retries every 100 ms, so a reader that stops reading
 * blocks the process until sonic-boom's retry recursion overflows (a few thousand retries while one line is written); then the
 * destination stops as after a write error.
 * A pipe on fd 1 is non-blocking (pino reads `process.stdout.fd`, which makes libuv set `O_NONBLOCK`), which is why a full one says
 * `EAGAIN`; a terminal is blocking, and one that stops reading holds the process whatever the exit flush does.
 */
function failSafeDestination(fd: number, sync: boolean): DestinationStream {
  // True while sonic-boom's 100 ms retry timer after an `EAGAIN` is pending: its chunk is then not in flight (see `drainSync`).
  // Cleared by a timer queued first: it fires before sonic-boom's own, which starts the retry write.
  let retrying = false;
  const sonic = pinoDestination({
    fd,
    sync,
    // Only the asynchronous destination buffers; a synchronous one (`--json`, `marmeon mcp`, pretty) is unbounded and waits for the
    // reader, and sonic-boom would drop a single larger entry.
    ...(sync ? {} : { maxLength: MAX_BUFFERED_BYTES }),
    retryEAGAIN: () => {
      retrying = true;
      setTimeout(() => {
        retrying = false;
      }, 100).unref();
      return true;
    },
  });
  // The notice goes to fd 2 with a synchronous write. Reading `process.stderr.fd` opens fd 2 as a stream, and libuv sets
  // `O_NONBLOCK` on a pipe: a full one then answers `EAGAIN`, which the catch below drops, instead of blocking the process. A
  // terminal stays blocking (one that stops reading holds the process, the known limit), and Node makes stdio pipes blocking on
  // Windows.
  if (fd === 1) void process.stderr.fd;
  let dead = false;
  const fail = (error: NodeJS.ErrnoException | typeof FLUSH_FAILED): void => {
    if (dead) return;
    dead = true;
    const state = sonic as unknown as Partial<SonicState>;
    state._bufs = [];
    state._writingBuf = '';
    state._len = 0;
    const code = error === FLUSH_FAILED ? undefined : error.code;
    // An error without an OS code (a RangeError from sonic-boom's retry recursion) is named by its own name.
    const named = code ?? (error === FLUSH_FAILED ? undefined : String(error.name || 'unknown error'));
    if (fd !== 1 || code === 'EPIPE') return;
    try {
      writeSync(2, `@marmeon/log: ${error === FLUSH_FAILED ? 'the exit flush to stdout failed' : `writing to stdout failed (${named})`}; log lines are dropped until the process restarts.\n`);
    } catch {
      // stderr is gone too: nobody is left to tell.
    }
  };
  // pino's listener turns the destination off for EPIPE; every error also reaches this one.
  sonic.on('error', fail);
  const write = sonic.write.bind(sonic);
  sonic.write = (chunk: string): boolean => (dead ? true : write(chunk));
  sonic.flushSync = (): void => {
    let error: NodeJS.ErrnoException | typeof FLUSH_FAILED | undefined;
    try {
      error = drainSync(sonic, fd, retrying);
    } catch {
      // Never a throw inside pino's exit hook, and never sonic-boom's own flush (it retries any error for ever).
      error = FLUSH_FAILED;
    }
    if (error) fail(error);
  };
  return sonic;
}

/** Where `createPinoLogger` writes and whose entries it also publishes. */
export interface PinoLoggerOptions {
  /** The stream the entries go to; default: stdout (stderr while a command prints JSON), pretty-printed for `format: 'pretty'`. */
  destination?: NodeJS.WritableStream;
  /** Its entries also go to the `log` channel while something listens; its `Redactor` and log-context sources apply. */
  app?: Application;
}

/** A pino-backed `Logger`: JSON lines, or pretty-printed for `format: 'pretty'`. */
export function createPinoLogger(config: LogOptions, options: PinoLoggerOptions = {}): Logger {
  // An untyped caller of the positional form (`config, stream, app`) would otherwise get a logger without its stream or app.
  if (arguments.length > 2 || options === null || typeof options !== 'object' || typeof (options as { write?: unknown }).write === 'function') {
    throw new TypeError('createPinoLogger(config, { destination, app }) takes the stream and the app in its options.');
  }
  const { destination, app } = options;
  // A command that prints JSON keeps stdout for its document: its log lines go to stderr (fd 2).
  const fd = consoleLogsGoToStderr() ? 2 : 1;
  const stream =
    destination ??
    (config.format === 'pretty'
      ? pretty()({ colorize: true, sync: true, ignore: 'pid,hostname,appEnv', destination: failSafeDestination(fd, true) })
      : failSafeDestination(fd, fd === 2));
  const redactor = redactorOf(app);
  const logger = pino(
    {
      level: config.level,
      // The app's environment on every entry (`APP_ENV`, informative) — a log shipper tells one deployment from another by it.
      base: config.environment === undefined ? undefined : { appEnv: config.environment },
      // Runs after the redaction in `mixinMergeStrategy`: in pretty mode, only escapes what pino-pretty prints outside JSON.
      formatters: {
        log: (object) => (config.format === 'pretty' ? terminalSafeEntry(object) : object) as Record<string, unknown>,
        // The root's bindings, `base` (undefined without an environment); a child's go through `PinoLogger.child()`.
        bindings: (bindings) => (config.format === 'pretty' && bindings ? terminalSafeEntry(bindings) : bindings),
      },
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
      // A key of the call's context that names a field of the framework is written as `context.<key>`: the mixin's values and
      // pino's own `level`, `time` and `msg` cannot be overridden by logged data.
      // A child's bindings are renamed for `level`, `time`, `msg` and `appEnv` only (`child()`); the framework binds `task` and the like itself.
      // The app's Redactor: sensitive keys at any depth, an error under any key as type, message and stack, masked. The call's
      // context is redacted here, before the rename (the mixin's values already in `mixin`): a name the app redacts (`msg`) is
      // judged as written.
      // A getter of the app's own that throws in the call's context must not make the log call throw: the entry is written with the
      // mixin's values (redacted part by part in `mixin`) and a constant (never the error, whose message may quote the value).
      mixinMergeStrategy: (mergeObject, mixinObject) =>
        Object.assign({}, withoutFrameworkFields(redactedLogPart(redactor, mergeObject as LogContext) ?? { ...UNREADABLE_PART }), mixinObject),
      mixin: (_merge, _level, instance) => withoutBound(redactedFrameworkFields(redactor, app), instance),
    },
    stream as never,
  );
  return new PinoLogger(logger, app, undefined, undefined, config.format === 'pretty');
}

/** Found by `marmeon discover` through the "marmeon" field in package.json. */
export class LogServiceProvider implements ServiceProvider {
  static config = [LogConfig];

  register(container: Container): void {
    container.singleton(Logger, (c) => createPinoLogger(c.make(LogConfig), { app: c.make(Application) }));
  }
}
