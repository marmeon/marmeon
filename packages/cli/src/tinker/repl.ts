import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import repl, { type REPLServer } from 'node:repl';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { style } from '../output.ts';
import type { TinkerSession } from './session.ts';
import { toJavaScript } from './typescript.ts';

type REPLEval = (code: string, context: object, file: string, callback: (error: Error | null, result?: unknown) => void) => void;
type Completer = (line: string, callback: (error: Error | null, result: [string[], string]) => void) => void;

export interface InteractiveOptions {
  /** The history file, or none (`--no-history`). */
  readonly history: string | undefined;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Closes the REPL (a signal ends the session like `.exit`). */
  readonly signal?: AbortSignal;
}

/**
 * The interactive REPL of a session: Node's own (top-level `await`, preview, multi-line input), with TypeScript input,
 * the helpers on its context, completion for the session's names and `.ls`. Resolves when it closes (`.exit`, Ctrl-D,
 * end of input) — after the inputs it was given finished.
 */
export async function interactive(session: TinkerSession, options: InteractiveOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  const evaluator = new Evaluator(session, output);
  const server = repl.start({
    prompt: style('green', '> '),
    input: options.input ?? process.stdin,
    output,
    // The process's own realm: a `new Date()` or `[]` typed here is an instance of the framework's Date and Array — in a
    // context of its own, `instanceof` checks (validation, the database driver) would fail on everything typed in.
    useGlobal: true,
    ignoreUndefined: true,
    eval: evaluator.eval,
    // A REPL with its own `eval` has no preview by default; the preview evaluates side-effect-free JavaScript only.
    preview: true,
    completer: completer(session, evaluator.complete),
  });
  session.attach(server.context as Record<string, unknown>);
  const history = options.history && keepHistory(options.history, output) ? options.history : undefined;
  defineCommands(server, session, history);
  if (history) await setupHistory(server, history);
  const closed = new Promise<void>((resolve) => server.once('exit', resolve));
  if (options.signal?.aborted) server.close();
  else options.signal?.addEventListener('abort', () => server.close(), { once: true });
  try {
    await closed;
    // Piped input ends while its inputs may still run: they finish first, then the session ends. At a terminal, leaving
    // (Ctrl-D, .exit) does not wait for an input that hangs.
    if (!options.signal?.aborted && !server.terminal) await evaluator.idle();
  } finally {
    evaluator.close();
    session.detach();
  }
}

/**
 * `--execute "<code>"`: one input, evaluated like a line of the REPL (TypeScript, `await`, the last expression's value).
 * Resolves with the value; rejects with the error.
 */
export async function evaluateOnce(session: TinkerSession, code: string): Promise<unknown> {
  const evaluator = new Evaluator(session, process.stderr);
  session.attach(evaluator.context);
  try {
    const input = toJavaScript(code);
    if ('incomplete' in input) throw new SyntaxError(`The code ends too early: ${input.incomplete.message.split('\n')[0]}`);
    if ('error' in input) throw input.error;
    return await evaluator.evaluate(input.code);
  } finally {
    evaluator.close();
    session.detach();
  }
}

/**
 * Evaluates the session's inputs, one after the other: TypeScript stripped, through the session (the sandbox's
 * transaction), by Node's own evaluator — top-level `await`, the last expression's value.
 *
 * Node's evaluator is the default `eval` of a REPL of its own that reads nothing (the engine): the REPL the developer
 * types into has the session's `eval` and hands each input over. The engine reports a failed input to its error handler,
 * not to its callback; {@link #handleError} gives that error to the input that runs, which reports it like any error
 * (the REPL prints it as `Uncaught …`). An error nothing waits for (a timer's) is printed as the REPL would.
 */
class Evaluator {
  readonly #session: TinkerSession;
  readonly #engine: REPLServer;
  #queue: Promise<void> = Promise.resolve();
  #fail: ((error: unknown) => void) | undefined;

  constructor(session: TinkerSession, output: NodeJS.WritableStream) {
    this.#session = session;
    this.#engine = repl.start({
      prompt: '',
      input: new PassThrough(),
      output,
      terminal: false,
      useGlobal: true,
      handleError: (error) => this.#handleError(error),
    });
  }

  /** Where inputs run — the process's global object (`useGlobal`). */
  get context(): Record<string, unknown> {
    return this.#engine.context as Record<string, unknown>;
  }

  /** The `eval` of the REPL the developer types into. */
  readonly eval: REPLEval = (code, _context, _file, callback) => {
    const input = toJavaScript(code);
    if ('incomplete' in input) return callback(new repl.Recoverable(input.incomplete), undefined);
    if ('error' in input) return callback(input.error, undefined);
    this.#queue = this.#queue.then(() =>
      this.evaluate(input.code).then(
        (value) => callback(null, value),
        (error: unknown) => {
          const hint = sandboxHint(this.#session, error);
          if (hint) this.#engine.output.write(`${style('yellow', hint)}\n`);
          callback(error as Error, undefined);
        },
      ),
    );
  };

  /** The engine's completion — for everything the session does not complete itself. */
  readonly complete: Completer = (line, callback) => {
    (this.#engine.completer as Completer).call(this.#engine, line, callback);
  };

  /**
   * Runs JavaScript through the session — the result of the last expression, or the error. A result that is a promise is
   * awaited (`repos.users.count()` shows the number, as with `await`) — inside the sandbox's transaction, too.
   */
  evaluate(code: string): Promise<unknown> {
    return this.#session.evaluate(code, () => this.#run(code));
  }

  /** Settles once every input given so far has finished. */
  idle(): Promise<void> {
    return this.#queue;
  }

  close(): void {
    this.#engine.close();
  }

  #run(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#fail = reject;
      this.#engine.eval(code, this.#engine.context, 'REPL', (error, value) => {
        this.#fail = undefined;
        if (error) reject(error);
        else resolve(value);
      });
    }).catch((error: unknown) => {
      throw withoutEvaluationFrames(error);
    });
  }

  #handleError(error: unknown): 'ignore' | 'print' {
    const fail = this.#fail;
    if (!fail) return 'print';
    this.#fail = undefined;
    fail(error);
    return 'ignore';
  }
}

/** A value as `--execute` prints it: a string as it is (for scripts), anything else inspected; `undefined` prints nothing. */
export function formatValue(value: unknown, colors: boolean): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : inspect(value, { colors, depth: 4 });
}

/** What to add to an error in the sandbox — the infrastructure on the app's SQLite file cannot write inside it. */
export function sandboxHint(session: TinkerSession, error: unknown): string | undefined {
  if (!session.sandbox || !(error instanceof Error) || error.name !== 'InfrastructureTransactionError') return undefined;
  return 'In --sandbox the whole session runs in one transaction on the default connection, so the cache, its locks and the sessions on that SQLite file cannot write. Give them a file of their own (CACHE_CONNECTION, SESSION_CONNECTION) or Redis — or leave out --sandbox.';
}

/**
 * The stack of an input's error without the frames of the evaluation (Node's evaluator, the session, the sandbox's
 * transaction) — what the REPL shows of its own inputs: the frames of the code the input ran, nothing below the input.
 */
function withoutEvaluationFrames(error: unknown): unknown {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return error;
  const lines = error.stack.split('\n').filter((line) => !/^\s+at (?:async )?node:repl:/.test(line));
  let cut = lines.findIndex((line) => /^\s+at ContextifyScript\.runInThisContext \(node:vm/.test(line));
  if (cut < 0) cut = lines.length;
  while (cut > 0 && /^\s+at REPL\d*:\d+:\d+$/.test(lines[cut - 1]!)) cut--;
  error.stack = lines.slice(0, cut).join('\n');
  return error;
}

/**
 * Completion: `repos.<Tab>` (repositories), `config.<Tab>`, `make(<Tab>` / `make('<Tab>` (class and token names) and
 * `url('<Tab>` (route names); everything else as the REPL completes it (the helpers are on its context).
 */
export function completer(session: TinkerSession, fallback: Completer): Completer {
  return (line, callback) => {
    const complete = (candidates: readonly string[], partial: string) => callback(null, [candidates.filter((name) => name.startsWith(partial)), partial]);
    const member = /\b(repos|config)\.([\w$]*)$/.exec(line);
    if (member?.[1] === 'repos') {
      session.repositoryNames().then((names) => complete(names, member[2]!), (error: Error) => callback(error, [[], line]));
      return;
    }
    if (member?.[1] === 'config') return complete(session.configNames(), member[2]!);
    const route = /\burl\(\s*['"`]([\w.:-]*)$/.exec(line);
    if (route) return complete(session.routeNames(), route[1]!);
    const make = /\bmake\(\s*['"`]?([\w$]*)$/.exec(line);
    if (make) {
      session.loadRepositories().then(() => complete(session.names(), make[1]!), () => complete(session.names(), make[1]!));
      return;
    }
    fallback.call(undefined, line, callback);
  };
}

function defineCommands(server: REPLServer, session: TinkerSession, history: string | undefined): void {
  const write = (text = '') => server.output.write(`${text}\n`);
  server.defineCommand('ls', {
    help: 'List the helpers, repositories and known names of this session',
    action() {
      void listHelpers(session, write).finally(() => server.displayPrompt());
    },
  });
  server.defineCommand('help', {
    help: 'Print this help message',
    action() {
      const commands = Object.entries(server.commands).sort(([a], [b]) => a.localeCompare(b));
      const width = Math.max(...commands.map(([name]) => name.length)) + 1;
      for (const [name, command] of commands) write(`${`.${name}`.padEnd(width)}  ${command?.help ?? ''}`);
      write();
      write('Helpers (.ls): app, make, db, repos, jobs, events, mail, url, t, config. Input may be TypeScript; await works.');
      if (session.sandbox) write('Sandbox: everything runs in one transaction on the default connection, rolled back when the session ends.');
      write(history ? `History: ${history} (plain text — leave it out with --no-history).` : 'No history (--no-history).');
      write('Press Ctrl+C to abort the current expression, Ctrl+D to exit.');
      server.displayPrompt();
    },
  });
}

async function listHelpers(session: TinkerSession, write: (text?: string) => void): Promise<void> {
  const helpers = session.helpers();
  const width = Math.max(...helpers.map((helper) => helper.usage.length));
  for (const helper of helpers) {
    const missing = helper.available ? '' : style('yellow', '  (not installed)');
    write(`  ${style('green', helper.usage.padEnd(width))}  ${helper.description}${missing}`);
  }
  try {
    const repositories = await session.repositoryNames();
    write();
    write(repositories.length ? `Repositories: ${repositories.map((name) => `repos.${name}`).join(', ')}` : 'Repositories: none (no *Repository.ts in the app).');
  } catch (error) {
    write(style('red', `Repositories could not be loaded: ${(error as Error).message}`));
  }
  const names = session.names();
  write(`Names (${names.length}, Tab completes them; make('Name') resolves one): ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`);
}

/** Node creates a new history file as 0600 but leaves an existing one as it is: tighten it, or keep no history. */
function keepHistory(file: string, output: NodeJS.WritableStream): boolean {
  try {
    if (existsSync(file)) chmodSync(file, 0o600);
    return true;
  } catch {
    output.write(`${style('dim', `No history: ${file} cannot be made owner-only.`)}\n`);
    return false;
  }
}

function setupHistory(server: REPLServer, file: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    server.setupHistory({ filePath: file, size: 1000, removeHistoryDuplicates: true }, (error) => (error ? reject(error) : resolve()));
  });
}
