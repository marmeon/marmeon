/**
 * Before a measurement: can the checkout still import what a measured process imports? The worktrees of `pnpm bench` live under
 * `$TMPDIR/marmeon-bench/` and are kept between runs — and macOS cleans `$TMPDIR` file by file, so a snapshot's `node_modules` can
 * lose files while its lockfile marker stays (`ERR_MODULE_NOT_FOUND` in the middle of a run). A smoke test imports the
 * modules first; a missing module removes every `node_modules` of the checkout and installs again, once.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** How a checkout is probed: Node with these arguments in `cwd`, importing every specifier. */
export interface ImportProbe {
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly specifiers: readonly string[];
}

/** What Node says when a package or a file of one is gone. */
export const MISSING_MODULE = /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/;

/** `undefined` when every specifier imports; otherwise Node's output. */
export function importProblem(probe: ImportProbe): string | undefined {
  const code = probe.specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n');
  const result = spawnSync(process.execPath, [...(probe.args ?? []), '--input-type=module', '-e', code], {
    cwd: probe.cwd,
    env: probe.env ?? process.env,
    encoding: 'utf8',
  });
  if (result.status === 0) return undefined;
  return `${result.stderr}${result.stdout}`.trim() || `node exited with ${result.status ?? result.signal}`;
}

/** Every `node_modules` of a pnpm checkout: the root's and each workspace package's (`packages/*`, `apps/*`). */
export function removeNodeModules(checkout: string): void {
  const dirs = [checkout];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(checkout, group))) continue;
    for (const entry of readdirSync(join(checkout, group), { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(checkout, group, entry.name));
  }
  for (const dir of dirs) rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
}

/** Node's sentence ("Cannot find module '…' imported from …"), not the line of its stack that throws. */
const firstLine = (text: string) => {
  const lines = text.split('\n');
  return (lines.find((line) => /Cannot find (?:package|module)/.test(line)) ?? lines.find((line) => MISSING_MODULE.test(line)) ?? lines[0]!).trim();
};

/**
 * Makes sure `checkout` can import what `probe` names: a missing module means damaged `node_modules` — they are removed and
 * installed again (`install`), then probed once more. Any other failure, or one that a fresh install does not fix, throws.
 */
export function ensureImportable(checkout: string, probe: ImportProbe, { install, log }: { install: (checkout: string) => void; log: (line: string) => void }): void {
  const problem = importProblem(probe);
  if (problem === undefined) return;
  if (!MISSING_MODULE.test(problem)) throw new Error(`${checkout} cannot import what the measurement needs:\n${problem}`);
  log(`  ${checkout}: ${firstLine(problem)} — damaged node_modules ($TMPDIR is cleaned file by file); removing them and installing again`);
  removeNodeModules(checkout);
  install(checkout);
  const again = importProblem(probe);
  if (again !== undefined) throw new Error(`${checkout} still cannot import what the measurement needs after a fresh install:\n${again}`);
}

/**
 * Creates `dir` for the bench's checkouts and refuses it unless only this user can write to it. The checkouts are reused between
 * runs and Node loads code from them (`--import`), so on a shared `/tmp` a directory another user pre-created, a link they
 * planted or a tree they can write to would run their code as this user. Everything the bench puts under `dir` is made by this
 * process, so checking `dir` and its ancestors is enough: every ancestor of the real path must belong to root or this user, and one
 * others can write to needs the sticky bit, or they could rename `dir` away after the check and put their own in its place.
 * Returns the real path of `dir`. Without `process.getuid` (Windows) the temp directory is per user and the owner and mode checks are skipped.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dirname(dir), { recursive: true });
  const target = join(realpathSync.native(dirname(dir)), basename(dir));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = lstatSync(target);
  if (!stat.isDirectory()) throw new Error(`${target} is not a plain directory (a link or a file); remove it and run the benchmark again`);
  const uid = process.getuid?.();
  if (uid === undefined) return target;
  if (stat.uid !== uid) throw new Error(`${target} belongs to another user; remove it or point TMPDIR elsewhere`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${target} is writable by other users; remove it or run chmod go-w on it`);
  for (let ancestor = dirname(target); ; ancestor = dirname(ancestor)) {
    const { uid: owner, mode } = lstatSync(ancestor);
    if (owner !== 0 && owner !== uid) throw new Error(`${ancestor} belongs to another user, so ${target} could be replaced; point TMPDIR elsewhere`);
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      throw new Error(`${ancestor} is writable by other users without the sticky bit, so ${target} could be replaced; run chmod +t or go-w on it`);
    }
    if (dirname(ancestor) === ancestor) return target;
  }
}
