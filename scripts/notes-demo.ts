/**
 * The notes demo (`examples/notes`) as `pnpm pack:smoke` checks it: the overlay applied to a starter kit made from the packed
 * framework, then that app's own tests, type check, lint, build and start. Functions for pack-smoke.ts, no command of their own.
 *
 * The overlay is `files/` (copied as they are), `edits.json` (`[{ file, find, replace }]`, every `find` exactly once) and
 * `commands.json` (`{ beforeCopy, afterCopy }`, each a list of `marmeon <command> …` lines).
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SmokeError } from './pack-smoke.ts';

/** `examples/notes` of this repository. */
export const OVERLAY = fileURLToPath(new URL('../examples/notes', import.meta.url));

export interface Edit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

export interface Commands {
  readonly beforeCopy: readonly string[];
  readonly afterCopy: readonly string[];
}

/** What `checkDemo` needs of the smoke app (`Smoke` of pack-smoke.ts). */
export interface DemoTarget {
  readonly app: string;
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): string;
  buildWithoutEnv(): string;
  serve(path: string, check?: (base: string, output: () => string) => Promise<void>): Promise<void>;
}

const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SmokeError(`${path}: ${(error as Error).message}`);
  }
};

/** The arguments of a `marmeon <command> …` line — anything else (another program, a shell construct) is refused. */
export function marmeonArguments(line: string, where: string): string[] {
  const words = line.split(' ');
  if (words[0] !== 'marmeon' || words.length < 2 || !words.slice(1).every((word) => /^[\w][\w:=./-]*$|^--[\w-]+(?:=[\w./-]+)?$/.test(word))) {
    throw new SmokeError(`${where}: "${line}" is not a "marmeon <command> …" line — a demo may run marmeon's commands, nothing else.`);
  }
  return words.slice(1);
}

/** `commands.json` of an overlay, checked: both lists are there and hold only `marmeon` lines. */
export function readCommands(overlay: string): Commands {
  const path = join(overlay, 'commands.json');
  const commands = read(path) as Partial<Record<keyof Commands, unknown>> | null;
  for (const key of ['beforeCopy', 'afterCopy'] as const) {
    const list = commands?.[key];
    if (!Array.isArray(list) || !list.every((line) => typeof line === 'string')) throw new SmokeError(`${path}: "${key}" must be a list of "marmeon <command>" lines.`);
    for (const line of list) marmeonArguments(line, `${path} › ${key}`);
  }
  return commands as unknown as Commands;
}

/** `edits.json` of an overlay, checked: objects with a relative `file` and a `find` and `replace` text. */
export function readEdits(overlay: string): Edit[] {
  const path = join(overlay, 'edits.json');
  const edits = read(path);
  if (!Array.isArray(edits)) throw new SmokeError(`${path}: must be a list of { file, find, replace }.`);
  for (const edit of edits as Partial<Edit>[]) {
    if (typeof edit?.file !== 'string' || typeof edit.find !== 'string' || edit.find === '' || typeof edit.replace !== 'string') {
      throw new SmokeError(`${path}: every edit needs a "file", a non-empty "find" and a "replace" (got ${JSON.stringify(edit)}).`);
    }
    const clean = normalize(edit.file);
    if (isAbsolute(edit.file) || edit.file.split('/').includes('..') || clean === '.' || clean.endsWith(sep) || clean.split(sep)[0] === 'node_modules') {
      throw new SmokeError(`${path}: "${edit.file}" must be a file of the app itself — not empty, not absolute, not outside it, not in node_modules.`);
    }
  }
  return edits as Edit[];
}

/** Every file below `dir`; none when it does not exist (an overlay may have no `files/`). */
function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/**
 * Turns the starter kit in `app` into the demo: `beforeCopy` commands, then `files/` copied over the app, then the edits, then
 * `afterCopy`. `run` runs one `marmeon` command (its arguments) in the app. Everything of the overlay is read and checked
 * first, so a wrong line stops the run before the app is touched. A `find` that occurs more or less than once fails with its
 * file and the count. Returns the files written, relative to the app.
 */
export function applyOverlay(app: string, run: (args: string[]) => void, overlay: string = OVERLAY): string[] {
  const commands = readCommands(overlay);
  const edits = readEdits(overlay);
  const files = filesBelow(join(overlay, 'files'));
  for (const line of commands.beforeCopy) run(marmeonArguments(line, 'beforeCopy'));
  const written = files.map((file) => relative(join(overlay, 'files'), file));
  for (const file of written) {
    cpSync(join(overlay, 'files', file), join(app, file), { recursive: true });
  }
  for (const edit of edits) {
    const target = resolve(app, edit.file);
    if (!existsSync(target)) throw new SmokeError(`${edit.file}: the overlay edits a file the starter kit does not have.`);
    const text = readFileSync(target, 'utf8');
    const found = text.split(edit.find).length - 1;
    if (found !== 1) throw new SmokeError(`${edit.file}: the text to replace occurs ${found} times, expected exactly once:\n${edit.find}`);
    writeFileSync(target, text.replace(edit.find, () => edit.replace));
  }
  for (const line of commands.afterCopy) run(marmeonArguments(line, 'afterCopy'));
  return written;
}

/**
 * The demo on the smoke app: the overlay, then the app's tests, type check, lint, build without `.env`, and `marmeon start` —
 * `/` answers 200, `/notes` sends a guest to `/login`.
 */
export async function checkDemo(smoke: DemoTarget, pm: 'pnpm', overlay: string = OVERLAY): Promise<void> {
  applyOverlay(smoke.app, (args) => void smoke.run(pm, ['exec', 'marmeon', ...args]), overlay);
  const tests = smoke.run(pm, ['run', 'test', '--reporter=verbose']);
  if (!/modules\/notes\/notes\.test\.ts/.test(tests)) throw new SmokeError(`vitest did not run the notes module's tests (notes.test.ts):\n${tests}`);
  if (!/Tests\s+\d+ passed/.test(tests)) throw new SmokeError(`the demo's tests did not pass:\n${tests}`);
  smoke.run(pm, ['run', 'typecheck']);
  smoke.run(pm, ['run', 'lint', '--deny-warnings']);
  smoke.buildWithoutEnv();
  await smoke.serve('/', async (base) => {
    const notes = await fetch(`${base}/notes`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await notes.body?.cancel();
    const location = notes.headers.get('location') ?? '';
    if (notes.status !== 302 || new URL(location, base).pathname !== '/login') {
      throw new SmokeError(`GET /notes as a guest answered ${notes.status}${location ? ` to ${location}` : ''} — expected a redirect to /login.`);
    }
  });
}

/**
 * For a kept app, to look at in a browser: the seeded test user (confirmed, test@example.com with the password `password`) and
 * a few notes of hers in the development database.
 */
export function sampleNotes(app: string, run: (args: string[]) => void): void {
  run(['db:seed']);
  const database = new DatabaseSync(join(app, 'storage/database.sqlite'));
  try {
    const user = database.prepare('SELECT id FROM users WHERE email = ?').get('test@example.com') as { id: number } | undefined;
    if (!user) throw new SmokeError('marmeon db:seed made no test user (test@example.com).');
    const now = new Date().toISOString();
    const insert = database.prepare('INSERT INTO notes (user_id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(user.id, 'Groceries', 'Milk\n\nBread, and something for the weekend.', 0, now, now);
    insert.run(user.id, 'Ideas', 'A note can have several paragraphs.\n\nThis is the second one.', 1, now, now);
    insert.run(user.id, 'Call the dentist', 'Before the end of the month.', 0, now, now);
  } finally {
    database.close();
  }
}
