import { join } from 'node:path';
import { Application, environment } from '@bespokecore/core';
import type { CommandInput } from '../command.ts';
import { style } from '../output.ts';
import type { TinkerSession } from '../tinker/session.ts';

/** The REPL (`node:repl`, the TypeScript transform) and the session, loaded when tinker runs — never on `bespoke start` (E138). */
type Repl = typeof import('../tinker/repl.ts');

/** Where the history of `bespoke tinker` is kept (plain text), relative to the app root. */
export const TINKER_HISTORY = 'storage/framework/tinker_history';

/**
 * `bespoke tinker` (E122): a REPL with the booted application — available in every environment (access to the shell is
 * the gate), with a banner that says which environment and database it talks to.
 *
 * - `--sandbox`: the whole session in one transaction on the default connection (E107), rolled back at the end — also
 *   on Ctrl-D, `.exit`, SIGINT/SIGTERM and errors. Jobs on the database queue join it and are gone with it.
 * - `--execute "<code>"`: evaluates the code, prints its value and exits (1 on an error) — for scripts.
 * - `--no-history`: keeps no history (it is plain text in `storage/framework/tinker_history`).
 */
export class TinkerCommand {
  static command = 'tinker';
  static description = 'Interact with the application (a REPL; --sandbox rolls back, --execute runs code)';
  static usage = '[--sandbox] [--execute "<code>"] [--no-history]';
  static options = {
    sandbox: { type: 'boolean' },
    execute: { type: 'string', short: 'e' },
    'no-history': { type: 'boolean' },
  } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const execute = typeof options.execute === 'string' ? options.execute : undefined;
    const [repl, { TinkerSession }] = await Promise.all([import('../tinker/repl.ts'), import('../tinker/session.ts')]);
    const session = new TinkerSession(this.#app, { sandbox: options.sandbox === true });
    try {
      await session.open();
    } catch (error) {
      output.error((error as Error).message);
      return 1;
    }
    // A signal ends the session like `.exit` — the sandbox rolls back before the process goes.
    let signalled = false;
    const stop = new AbortController();
    const onSignal = () => {
      signalled = true;
      stop.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      if (execute !== undefined) {
        // Scripts read stdout: the value goes there, everything else to stderr.
        if (environment.isProtected()) output.warn(this.#productionLine(session));
        const aborted = new Promise<number>((resolve) => stop.signal.addEventListener('abort', () => resolve(130), { once: true }));
        return await Promise.race([this.#execute(repl, session, execute, output), aborted]);
      }
      const history = options['no-history'] === true ? undefined : join(root, TINKER_HISTORY);
      this.#banner(session, output, history);
      await repl.interactive(session, { history, signal: stop.signal });
      return signalled ? 130 : 0;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await session.close();
      if (session.sandbox) {
        const done = `${style('cyan', 'ℹ')} Sandbox: rolled back.\n`;
        if (execute === undefined) process.stdout.write(done);
        else process.stderr.write(done);
      }
    }
  }

  async #execute(repl: Repl, session: TinkerSession, code: string, output: CommandInput['output']): Promise<number> {
    try {
      const text = repl.formatValue(await repl.evaluateOnce(session, code), process.stdout.isTTY === true);
      if (text !== undefined) output.line(text);
      return 0;
    } catch (error) {
      output.error(describe(error));
      const hint = repl.sandboxHint(session, error);
      if (hint) output.warn(hint);
      return 1;
    }
  }

  #banner(session: TinkerSession, output: CommandInput['output'], history: string | undefined): void {
    const env = process.env.NODE_ENV ?? '(not set)';
    const database = session.database();
    const parts = [style('bold', 'BespokeCore tinker'), session.appName(), `NODE_ENV=${env}`, ...(database ? [`db ${database}`] : []), '.ls lists helpers'];
    output.line(parts.join(' · '));
    if (session.sandbox) {
      output.line(style('cyan', 'Sandbox: every change to the default connection is rolled back when the session ends (mails, files and Redis are real).'));
      if (database?.startsWith('sqlite')) output.line(style('dim', 'SQLite: once the session wrote, other processes (the dev server, a worker) cannot write to the file until it ends.'));
    }
    // Protected (E139): production, staging and a missing NODE_ENV get the red line.
    if (environment.isProtected()) output.line(style(['bold', 'red'], this.#productionLine(session)));
    if (!history) output.line(style('dim', 'No history (--no-history).'));
  }

  #productionLine(session: TinkerSession): string {
    const database = session.database();
    const name = environment.name();
    const label = name === undefined || name === 'production' ? 'PRODUCTION' : `PROTECTED (${name})`;
    return `${label} — NODE_ENV=${name ?? '(not set)'}${database ? `, db ${database}` : ''}: ${session.sandbox ? 'changes are rolled back at the end (--sandbox).' : 'every change is real.'}`;
  }
}

/** An error of `--execute`: its stack (without the evaluation's frames), or — for a syntax error — its message. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'SyntaxError' || !error.stack?.startsWith(`${error.name}: `)) return `${error.name}: ${error.message}`;
  return error.stack;
}
