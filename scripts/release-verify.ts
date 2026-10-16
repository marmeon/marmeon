/**
 * `pnpm release:verify <commit>` — the maintainer's check before approving staged packages on npm: rebuilds the release commit in a
 * temporary git worktree (the current checkout stays as it is), downloads every tarball staged on npm (`npm stage download`) and
 * compares the SHA-512 of each with the rebuilt tarball of the same name. Exit 0 only when every staged tarball is a rebuilt one and
 * every rebuilt one is staged.
 *
 * Why: the builds are reproducible, so a difference means the CI changed the tarballs (a compromised runner or action, a modified
 * workflow). It does not catch a compromised dependency in the lockfile: the rebuild uses the same lockfile. Needs an `npm login`
 * session. See CONTRIBUTING.md, "Releasing". Imports nothing but `node:*` and `./release-pack.ts`.
 *
 *   pnpm release:verify <commit>   # the SHA from the Release run's log
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUMS_FILE } from './release-pack.ts';

/** The subprocesses the check starts; injected so a test runs without git, pnpm or npm. */
export interface Commands {
  /** Runs a command with inherited stdio; throws when it exits non-zero. */
  run(command: string, args: readonly string[], cwd: string): void;
  /** Runs a command and returns its stdout; throws when it exits non-zero. */
  capture(command: string, args: readonly string[], cwd: string): string;
}

export const spawnCommands: Commands = {
  run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
  },
  capture(command, args, cwd) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  },
};

export interface StagedItem {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
}

export type Outcome = 'match' | 'differs' | 'not-rebuilt' | 'not-staged';

export interface Entry {
  readonly outcome: Outcome;
  /** The tarball's file name as `pnpm pack` writes it. */
  readonly file: string;
  /** The stage id; absent for a rebuilt tarball that is not staged. */
  readonly id?: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly staged?: string;
  readonly rebuilt?: string;
}

export interface Verification {
  readonly sha: string;
  readonly entries: readonly Entry[];
  readonly stagedIds: readonly string[];
  readonly ok: boolean;
}

const sha512 = (data: Uint8Array) => createHash('sha512').update(data).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file name `pnpm pack` gives a package's tarball: `@marmeon/core` 1.2.3 → `marmeon-core-1.2.3.tgz`. */
export const tarballName = (packageName: string, version: string): string => `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

/** Reads the JSON of `npm stage list --json`; anything but an array of items with a string `id`, `packageName` and `version` is an error. */
export function parseStageList(output: string): StagedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('`npm stage list --json` did not print JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('`npm stage list --json` did not print an array');
  return parsed.map((item: unknown) => {
    const { id, packageName, version } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof id !== 'string' || typeof packageName !== 'string' || typeof version !== 'string') {
      throw new Error('`npm stage list --json` printed an item without a string id, packageName and version');
    }
    if (!UUID.test(id)) throw new Error(`\`npm stage list --json\` printed a stage id that is not a UUID: ${id}`);
    return { id, packageName, version };
  });
}

/** Compares the staged tarballs (by stage id) with the rebuilt ones (by file name), both as SHA-512 hashes. */
export function compare(staged: readonly (StagedItem & { readonly sha512: string })[], rebuilt: ReadonlyMap<string, string>): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const item of staged) {
    const file = tarballName(item.packageName, item.version);
    const base = { file, id: item.id, packageName: item.packageName, version: item.version, staged: item.sha512 };
    const hash = rebuilt.get(file);
    if (hash === undefined) {
      entries.push({ ...base, outcome: 'not-rebuilt' });
      continue;
    }
    seen.add(file);
    entries.push({ ...base, outcome: hash === item.sha512 ? 'match' : 'differs', rebuilt: hash });
  }
  for (const [file, hash] of [...rebuilt].sort(([a], [b]) => a.localeCompare(b))) {
    if (!seen.has(file)) entries.push({ outcome: 'not-staged', file, rebuilt: hash });
  }
  return entries;
}

function describeEntry(entry: Entry): string {
  const stage = `stage ${entry.id}`;
  const short = (hash?: string) => `${(hash ?? '').slice(0, 16)}…`;
  switch (entry.outcome) {
    case 'match':
      return `✓ ${entry.file}  matches (${stage})`;
    case 'differs':
      return `✗ ${entry.file}  differs (${stage}): staged sha512 ${short(entry.staged)}, rebuilt ${short(entry.rebuilt)}`;
    case 'not-rebuilt':
      return `✗ ${entry.packageName}@${entry.version}  staged (${stage}), but the rebuild has no ${entry.file}`;
    case 'not-staged':
      return `✗ ${entry.file}  rebuilt, but not staged`;
  }
}

/** The names of the tarballs `release-pack.ts` wrote, hashed here rather than taken from `SHA512SUMS`. */
function rebuiltHashes(directory: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of readFileSync(join(directory, SUMS_FILE), 'utf8').split('\n')) {
    if (line === '') continue;
    const file = line.replace(/^[0-9a-f]+ {2}/, '');
    hashes.set(file, sha512(readFileSync(join(directory, file))));
  }
  return hashes;
}

/**
 * Rebuilds `commit` in a temporary worktree and compares its tarballs with the staged ones. Always removes the worktree and the
 * temporary directory; a failure of the removal is logged and does not hide an error of the check.
 */
export function releaseVerify(root: string, commit: string, commands: Commands, log: (line: string) => void = console.log): Verification {
  if (commit.startsWith('-')) throw new Error(`${commit} is not a commit — it looks like an option`);
  let sha: string;
  try {
    sha = commands.capture('git', ['rev-parse', '--verify', `${commit}^{commit}`], root).trim();
  } catch {
    throw new Error(`${commit} is not a commit in this repository — try \`git fetch\` first`);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`git resolved ${commit} to "${sha}", not a commit SHA`);
  log(`release-verify: ${commit} is ${sha}`);

  const tmp = mkdtempSync(join(tmpdir(), 'marmeon-release-verify-'));
  const source = join(tmp, 'source');
  const tarballs = join(tmp, 'tarballs');
  let worktree = false;
  try {
    commands.run('git', ['worktree', 'add', '--detach', source, sha], root);
    worktree = true;
    commands.run('pnpm', ['install', '--frozen-lockfile'], source);
    commands.run('pnpm', ['run', 'clean'], source);
    commands.run('pnpm', ['build'], source);
    commands.run('node', ['scripts/release-pack.ts', tarballs], source);
    const rebuilt = rebuiltHashes(tarballs);

    const staged = parseStageList(commands.capture('npm', ['stage', 'list', '--json'], root));
    if (staged.length === 0) throw new Error('nothing is staged on npm — there is nothing to approve');
    const downloaded = staged.map((item) => {
      const directory = join(tmp, 'staged', item.id);
      mkdirSync(directory, { recursive: true });
      commands.run('npm', ['stage', 'download', item.id], directory);
      const files = readdirSync(directory).filter((name) => name.endsWith('.tgz'));
      if (files.length !== 1) throw new Error(`\`npm stage download ${item.id}\` wrote ${files.length} tarballs, expected one`);
      return { ...item, sha512: sha512(readFileSync(join(directory, files[0]!))) };
    });

    const entries = compare(downloaded, rebuilt);
    for (const entry of entries) log(describeEntry(entry));
    const ok = entries.every((entry) => entry.outcome === 'match');
    if (ok) {
      log(`release-verify: all ${entries.length} staged tarballs are the rebuild of ${sha} — approve them on npmjs.com`);
    } else {
      log(`release-verify: the staged tarballs are not the rebuild of ${sha} — do not approve.`);
      const ours = entries.filter((entry) => entry.id !== undefined && entry.outcome !== 'not-rebuilt');
      const others = entries.filter((entry) => entry.id !== undefined && entry.outcome === 'not-rebuilt');
      if (ours.length > 0) log('Reject the staged versions of this release:');
      for (const entry of ours) log(`  npm stage reject ${entry.id}`);
      if (others.length > 0) {
        log('Staged, but not a package of this rebuild — not part of this release; check them before rejecting:');
        for (const entry of others) log(`  ${entry.packageName}@${entry.version}  (stage ${entry.id})`);
      }
      log('Then look into the build job of the Release run.');
    }
    return { sha, entries, stagedIds: staged.map((item) => item.id), ok };
  } finally {
    const failures: string[] = [];
    if (worktree) {
      try {
        commands.run('git', ['worktree', 'remove', '--force', source], root);
      } catch (error) {
        failures.push(`could not remove the worktree ${source}: ${(error as Error).message}`);
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(tmp)) failures.push(`could not remove ${tmp}`);
    } catch (error) {
      failures.push(`could not remove ${tmp}: ${(error as Error).message}`);
    }
    if (worktree) {
      try {
        commands.run('git', ['worktree', 'prune'], root);
      } catch {
        // Best effort: a stale entry in .git/worktrees is harmless and `git worktree prune` clears it later.
      }
    }
    for (const failure of failures) console.error(`✗ cleanup: ${failure}`);
  }
}

if (import.meta.main) {
  const commit = process.argv[2];
  if (!commit || process.argv.length !== 3) {
    console.error('usage: pnpm release:verify <commit>');
    process.exit(1);
  }
  // A signal does not kill this process: the child gets it too and fails, so the synchronous run reaches `finally` and cleans up.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => undefined);
  try {
    const result = releaseVerify(fileURLToPath(new URL('..', import.meta.url)), commit, spawnCommands);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
