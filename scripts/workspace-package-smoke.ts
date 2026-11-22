/**
 * A package in the app's workspace (docs/package-development.md#a-package-in-your-apps-workspace) on the smoke app. The files come
 * from the titled blocks of that section, word for word, and the commands from its `sh` block. With the variable and without the
 * package's `dist/`, `dev` (its server and the child `node --watch` runs), `migrate` and `check` run the package's source; without the
 * variable `build` and `start` run its `dist/`, told apart by the `origin` the package reports. Each of them fails the other way round:
 * without the variable and without `dist/`, or without `customConditions` for the types. A function, no command of its own.
 *
 * The app is left as it was found: every file below it (but `node_modules`, `.git` and `vendor/`) is put back byte for byte, the
 * workspace package's link is removed again, and a difference is an error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks } from './guides.ts';
import { freePort, SmokeError, type Launched } from './pack-smoke.ts';

const PAGE = fileURLToPath(new URL('../docs/package-development.md', import.meta.url));
const HEADING = "A package in your app's workspace";
/** The condition as the section writes it into `NODE_OPTIONS`. */
const FLAG = '--conditions=@marmeon/source';
/** The commands of the section's `sh` block, in order. */
export const COMMANDS = ['pnpm add @acme/status-board@workspace:*', 'pnpm marmeon migrate', 'pnpm marmeon check', 'pnpm marmeon dev'];
const PACKAGE = 'packages/status-board';
/** The titles the check writes files from. */
const TITLES = ['pnpm-workspace.yaml', `${PACKAGE}/package.json`, `${PACKAGE}/tsconfig.json`, `${PACKAGE}/src/index.ts`, 'tsconfig.json', 'package.json', 'modules/home/status.ts'];

/** What the check needs of the smoke app (`Smoke` of pack-smoke.ts). */
export interface WorkspaceTarget {
  readonly app: string;
  readonly env: NodeJS.ProcessEnv;
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): string;
  buildWithoutEnv(): string;
  serve(path: string, check?: (base: string, output: () => string) => Promise<void>): Promise<void>;
  launch(command: string, args: string[], env?: NodeJS.ProcessEnv): Launched;
}

/** The titled blocks of the section (title → text) and the lines of its `sh` block. */
export function sectionBlocks(page: string): { titled: Map<string, string>; commands: string[] } {
  const start = page.indexOf(`\n## ${HEADING}\n`);
  if (start === -1) throw new SmokeError(`docs/package-development.md has no section "${HEADING}".`);
  const rest = page.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const found = blocks(end === -1 ? rest : rest.slice(0, end + 1));
  const titled = new Map<string, string>();
  for (const block of found) {
    if (block.title === undefined) continue;
    if (titled.has(block.title)) throw new SmokeError(`the section "${HEADING}" has two blocks titled ${block.title}.`);
    titled.set(block.title, block.text);
  }
  for (const title of TITLES) if (!titled.has(title)) throw new SmokeError(`the section "${HEADING}" has no block titled ${title}.`);
  const sh = found.filter((block) => block.lang === 'sh');
  if (sh.length !== 1) throw new SmokeError(`the section "${HEADING}" must hold one sh block, it holds ${sh.length}.`);
  const commands = sh[0]!.text.split('\n');
  if (commands.join('\n') !== COMMANDS.join('\n')) throw new SmokeError(`the sh block of "${HEADING}" holds:\n${commands.join('\n')}\nthe smoke runs:\n${COMMANDS.join('\n')}`);
  return { titled, commands };
}

/** Adds `extra` into `base`: objects are merged key by key, anything else is replaced. */
function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const old = result[key];
    const objects = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof old === 'object' && old !== null && !Array.isArray(old);
    result[key] = objects ? merge(old as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return result;
}

interface Snapshot {
  readonly files: Map<string, Buffer>;
  readonly dirs: Set<string>;
}

/** What the smoke never writes, or what a later `pnpm install` rebuilds. */
const LEFT_ALONE = new Set(['node_modules', '.git', 'vendor']);

function walk(root: string, visit: (path: string, directory: boolean) => void, dir = ''): void {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (LEFT_ALONE.has(entry.name) && dir === '') continue;
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    visit(path, entry.isDirectory());
    if (entry.isDirectory()) walk(root, visit, path);
  }
}

function snapshot(app: string): Snapshot {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  walk(app, (path, directory) => {
    if (directory) dirs.add(path);
    else files.set(path, readFileSync(join(app, path)));
  });
  return { files, dirs };
}

/** The paths where the app differs from `before`. */
function differences(app: string, before: Snapshot): string[] {
  const now = snapshot(app);
  const changed = [...new Set([...before.files.keys(), ...now.files.keys()])].filter((path) => {
    const was = before.files.get(path);
    const is = now.files.get(path);
    return was === undefined || is === undefined || !was.equals(is);
  });
  const dirs = [...new Set([...before.dirs, ...now.dirs])].filter((path) => before.dirs.has(path) !== now.dirs.has(path));
  return [...changed, ...dirs.map((path) => `${path}/`)].sort();
}

/** Puts every file back that `before` held, removes what is new, and takes the workspace package's link out of `node_modules`. */
function restore(smoke: WorkspaceTarget, before: Snapshot, pnpmFlags: readonly string[]): void {
  const app = smoke.app;
  const now: string[] = [];
  walk(app, (path) => now.push(path));
  for (const path of now) {
    if (!before.files.has(path) && !before.dirs.has(path)) rmSync(join(app, path), { recursive: true, force: true });
  }
  for (const dir of [...before.dirs].sort()) mkdirSync(join(app, dir), { recursive: true });
  for (const [path, content] of before.files) {
    const file = join(app, path);
    if (!existsSync(file) || !readFileSync(file).equals(content)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  smoke.run('pnpm', ['install', ...pnpmFlags, '--reporter', 'append-only']);
  // pnpm takes the link out but leaves the scope's directory: empty, and none the app had.
  const scope = join(app, 'node_modules/@acme');
  if (existsSync(scope) && readdirSync(scope).length === 0) rmSync(scope, { recursive: true });
  const left = differences(app, before);
  if (existsSync(scope)) left.push('node_modules/@acme');
  if (left.length > 0) throw new SmokeError(`the app is not as it was before the workspace package: ${left.join(', ')}`);
}

interface Answer {
  readonly origin: string;
  readonly pid: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `GET /status-board` of the package until it answers (a process that ended first is an error with its output). */
async function answer(running: Launched, port: number, what: string): Promise<Answer> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (running.hasExited()) throw new SmokeError(`${what} ended before it answered:\n${running.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status-board`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      if (response.status === 200) {
        let parsed: Partial<Answer>;
        try {
          parsed = JSON.parse(body) as Partial<Answer>;
        } catch {
          throw new SmokeError(`${what} answered 200 with no JSON: ${body.slice(0, 300)}`);
        }
        if (typeof parsed.origin === 'string' && typeof parsed.pid === 'number') return { origin: parsed.origin, pid: parsed.pid };
        throw new SmokeError(`${what} answered ${body}, expected the origin and the pid of the package.`);
      }
    } catch (error) {
      if (error instanceof SmokeError) throw error;
    }
    await wait(250);
  }
  throw new SmokeError(`${what} did not answer within 90 s:\n${running.output()}`);
}

/** A `marmeon dev` that stops at the boot: its error in the output, no answer. `node --watch` stays up for the next change, so the process is stopped here. */
async function failsToStart(running: Launched, port: number, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!/Could not start the application[\s\S]*dist\/index/.test(running.output()) && !running.hasExited()) {
    if (Date.now() > deadline) throw new SmokeError(`${what} neither failed nor ended within 60 s:\n${running.output()}`);
    await wait(250);
  }
  if (!running.output().includes('Could not start the application') || !running.output().includes('dist/index')) {
    throw new SmokeError(`${what} ended without the start error that names the package's dist/index:\n${running.output()}`);
  }
  const response = await fetch(`http://127.0.0.1:${port}/status-board`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
  if (response?.status === 200) throw new SmokeError(`${what} failed to start and still answered 200.`);
}

/** The parent process id and the command line of a process. */
function psOf(pid: number): { ppid: number; command: string } {
  const out = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  const match = /^(\d+)\s+(.*)$/s.exec(out);
  if (!match) throw new SmokeError(`ps knows no process ${pid}.`);
  return { ppid: Number(match[1]), command: match[2]! };
}

/** The command in the app without the variable, and without `pnpm`'s script: its status and output. */
function marmeonWithout(smoke: WorkspaceTarget, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(join(smoke.app, 'node_modules/.bin/marmeon'), args, { cwd: smoke.app, env: smoke.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A command that must end with a failure that names `dist/index.d.ts`, the file the package's `types` condition leads to. */
function failsWithoutDist(smoke: WorkspaceTarget, args: string[], phrase = 'Could not start the application: ENOENT'): void {
  const { status, output } = marmeonWithout(smoke, args);
  if (status === 0 || !output.includes(phrase) || !output.includes('dist/index.d.ts')) throw new SmokeError(`marmeon ${args.join(' ')} without the variable and without dist/ should fail on dist/index.d.ts (exit ${status}):\n${output}`);
}

/** The test the smoke adds: the test file loads the source, a process it starts does not. */
const TEST_FILE = `import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { origin } from '@acme/status-board';
import { statusOrigin } from './status.ts';

test('the test file loads the package from src/', () => {
  expect(origin).toBe('source');
});

test('a file the test imports loads the package from src/', () => {
  expect(statusOrigin).toBe('source');
});

test('a process the test starts loads dist/, as it has no variable', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log((await import('@acme/status-board')).origin)"], { encoding: 'utf8' });
  expect(child.stdout.trim()).toBe('dist');
});
`;

/** The section on the smoke app: the proof described at the top of this file; the app as found afterwards. */
export async function checkWorkspacePackage(
  smoke: WorkspaceTarget,
  pnpmFlags: readonly string[],
  page: string = readFileSync(PAGE, 'utf8'),
  proof: typeof prove = prove,
): Promise<void> {
  const { titled, commands } = sectionBlocks(page);
  const before = snapshot(smoke.app);
  try {
    await proof(smoke, titled, commands, pnpmFlags);
  } catch (error) {
    // The proof's error is the one to read; a restore that fails on top of it is attached, not put in its place.
    try {
      restore(smoke, before, pnpmFlags);
    } catch (restoring) {
      if (error instanceof Error) error.message += `\n(and restoring the app failed too: ${(restoring as Error).message})`;
    }
    throw error;
  }
  restore(smoke, before, pnpmFlags);
}

export async function prove(smoke: WorkspaceTarget, titled: ReadonlyMap<string, string>, commands: readonly string[], pnpmFlags: readonly string[]): Promise<void> {
  const app = smoke.app;
  const block = (title: string): string => {
    const text = titled.get(title);
    if (text === undefined) throw new SmokeError(`the section "${HEADING}" has no block titled ${title}.`);
    return text;
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), text.endsWith('\n') ? text : `${text}\n`);
  };
  const mergeJson = (path: string) => {
    const current = JSON.parse(readFileSync(join(app, path), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(app, path), `${JSON.stringify(merge(current, JSON.parse(block(path)) as Record<string, unknown>), null, 2)}\n`);
  };

  // The package, the app's side of it, and the install.
  for (const file of ['package.json', 'tsconfig.json', 'src/index.ts']) write(`${PACKAGE}/${file}`, block(`${PACKAGE}/${file}`));
  write('modules/home/status.ts', block('modules/home/status.ts'));
  writeFileSync(join(app, 'pnpm-workspace.yaml'), `${block('pnpm-workspace.yaml')}\n${readFileSync(join(app, 'pnpm-workspace.yaml'), 'utf8')}`);
  mergeJson('tsconfig.json');
  mergeJson('package.json');
  const [add, migrate, check] = commands.map((line) => line.split(' ').slice(1)) as [string[], string[], string[]];
  smoke.run('pnpm', [...add, ...pnpmFlags, '--reporter', 'append-only']);
  if (!existsSync(join(app, 'node_modules/@acme/status-board/package.json'))) throw new SmokeError('pnpm add did not link @acme/status-board into node_modules.');
  const marmeonScript = (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.marmeon;
  if (marmeonScript !== `NODE_OPTIONS=${FLAG} marmeon`) throw new SmokeError(`the marmeon script is "${marmeonScript}".`);
  rmSync(join(app, PACKAGE, 'dist'), { recursive: true, force: true });

  // Without dist/: the failures first, then the source.
  failsWithoutDist(smoke, ['migrate']);
  failsWithoutDist(smoke, ['check', '--only=boot'], 'ENOENT');
  failsWithoutDist(smoke, ['build']);
  const types = join(app, 'tsconfig.json');
  const tsconfig = readFileSync(types, 'utf8');
  const without = JSON.parse(tsconfig) as { compilerOptions: Record<string, unknown> };
  delete without.compilerOptions.customConditions;
  writeFileSync(types, JSON.stringify(without, null, 2));
  try {
    const { status, output } = marmeonWithout(smoke, ['check', '--only=types']);
    if (status === 0 || !output.includes('TS2307')) throw new SmokeError(`marmeon check --only=types without customConditions and without dist/ should fail with TS2307 (exit ${status}):\n${output}`);
  } finally {
    writeFileSync(types, tsconfig);
  }
  smoke.run('pnpm', migrate);
  const checked = smoke.run('pnpm', check);
  if (!/✓ types/.test(checked) || !/✓ boot/.test(checked)) throw new SmokeError(`pnpm marmeon check did not pass types and boot without dist/:\n${checked}`);

  // dev: its server answers from the source, and that server is the child `node --watch` runs.
  const port = await freePort();
  const dev = smoke.launch('pnpm', commands[3]!.split(' ').slice(1), { PORT: String(port), HOST: '127.0.0.1' });
  try {
    const served = await answer(dev, port, 'pnpm marmeon dev');
    if (served.origin !== 'source') throw new SmokeError(`pnpm marmeon dev without dist/ answered ${served.origin}, expected source.`);
    const server = psOf(served.pid);
    if (served.pid === dev.pid || !psOf(server.ppid).command.includes('--watch')) {
      throw new SmokeError(`the server of pnpm marmeon dev (${served.pid}) is not the child of node --watch: ${psOf(server.ppid).command}`);
    }
  } finally {
    await dev.stop();
  }
  // Without the variable, and with only the Node flag: `dev` serves from a child that gets neither.
  const bin = join(app, 'node_modules/.bin/marmeon');
  const launcher = join(app, 'node_modules/marmeon/bin/marmeon.js');
  for (const [what, command, args] of [
    ['marmeon dev without the variable', bin, ['dev']],
    ['node --conditions=@marmeon/source marmeon.js dev', process.execPath, [FLAG, launcher, 'dev']],
  ] as const) {
    const failing = await freePort();
    const running = smoke.launch(command, [...args], { PORT: String(failing), HOST: '127.0.0.1' });
    try {
      await failsToStart(running, failing, what);
    } finally {
      await running.stop();
    }
  }

  // With dist/ and without the variable: `build` and `start` answer from the build, which the origin tells from the source.
  smoke.run(bin, ['package:build', PACKAGE, '--clean']);
  smoke.buildWithoutEnv();
  await smoke.serve('/status-board', async (base) => {
    const response = await fetch(`${base}/status-board`, { signal: AbortSignal.timeout(5_000) });
    const body = (await response.json()) as Partial<Answer>;
    if (body.origin !== 'dist') throw new SmokeError(`marmeon start answered ${JSON.stringify(body)}, expected the origin dist.`);
  });
  // The forgotten variable: dev answers from the stale dist/ and says nothing about it; the variable turns it to the source again.
  for (const [what, env, origin] of [
    ['marmeon dev without the variable', {}, 'dist'],
    ['marmeon dev with the variable and with dist/', { NODE_OPTIONS: FLAG }, 'source'],
  ] as const) {
    const free = await freePort();
    const running = smoke.launch(bin, ['dev'], { ...env, PORT: String(free), HOST: '127.0.0.1' });
    try {
      const served = await answer(running, free, what);
      if (served.origin !== origin) throw new SmokeError(`${what} answered ${served.origin}, expected ${origin}.`);
      if (origin === 'dist') {
        // Read first: the server's own line is there, so an empty output cannot pass for silence.
        if (!running.output().includes('Marmeon in development')) throw new SmokeError(`${what}: the output has no start line, so it was not read:\n${running.output()}`);
        const said = ['@marmeon/source', 'NODE_OPTIONS', 'condition', 'stale', 'dist'].filter((word) => running.output().toLowerCase().includes(word.toLowerCase()));
        if (said.length > 0) throw new SmokeError(`${what} should say nothing about the stale dist/, it says ${said.join(', ')}:\n${running.output()}`);
      }
    } finally {
      await running.stop();
    }
  }
  // Tests: the file and its imports load the source, a process it starts the dist/.
  write('modules/home/status-board.test.ts', TEST_FILE);
  const tests = smoke.run(join(app, 'node_modules/.bin/vitest'), ['run', 'modules/home/status-board.test.ts', '--reporter=verbose']);
  if (!tests.includes('the test file loads the package from src/') || !tests.includes('a process the test starts loads dist/') || !tests.includes('a file the test imports loads the package from src/') || !/Tests\s+3 passed/.test(tests)) {
    throw new SmokeError(`vitest did not prove what it loads:\n${tests}`);
  }
}
