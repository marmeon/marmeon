import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EXACT_VERSION, FRAMEWORK_NAME, readManifest } from './manifest.ts';
import { readPnpmWorkspace } from './pnpm-workspace.ts';
import type { Version } from './versions.ts';

export type PackageManagerName = 'pnpm' | 'npm';

export type PackageManagerRefusal = 'unreadable' | 'no-lockfile' | 'workspace' | 'unsupported' | 'ambiguous' | 'conflict';

/** The answer of {@link detectPackageManager}. `message` carries names from the app's files, so a command prints it through its output (`escapeControl`). */
export type PackageManagerChoice =
  | { readonly ok: true; readonly name: PackageManagerName; readonly lockfile: string }
  | { readonly ok: false; readonly reason: PackageManagerRefusal; readonly message: string; /** What the developer can do about it, when there is something to say beyond the message. */ readonly fix?: string; readonly found: string[] };

const PNPM_LOCK = ['pnpm-lock.yaml'];
const NPM_LOCK = ['npm-shrinkwrap.json', 'package-lock.json'];
const OTHER_LOCK = ['yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock', 'vlt-lock.json'];
const LOCKFILES = [...PNPM_LOCK, ...NPM_LOCK, ...OTHER_LOCK];

const lockfilesIn = (dir: string): string[] => LOCKFILES.filter((name) => existsSync(join(dir, name)));

/** The ancestors of `root`, nearest first. */
function ancestors(root: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  return dirs;
}

/**
 * Why `root` is part of a workspace (or is the root of one), or `undefined`. The globs of a workspace are not evaluated: a package
 * manager may write the lockfile of the parent instead of the app's, so any workspace around the app, or an app that holds members, is refused.
 */
function workspaceProblem(root: string): string | undefined {
  const own = join(root, 'pnpm-workspace.yaml');
  const ownExists = existsSync(own);
  if (readManifest(join(root, 'package.json'))?.workspaces !== undefined) return 'package.json has "workspaces", so this directory is the root of a workspace';
  if (ownExists) {
    const workspace = readPnpmWorkspace(own);
    if (!workspace.readable) return `pnpm-workspace.yaml could not be read (line ${workspace.line}), so Marmeon cannot tell whether this directory is the root of a workspace`;
    if (workspace.packages) return 'pnpm-workspace.yaml has "packages", so this directory is the root of a workspace';
  }
  for (const dir of ancestors(root)) {
    if (!ownExists && existsSync(join(dir, 'pnpm-workspace.yaml'))) return `${join(dir, 'pnpm-workspace.yaml')} is in a parent directory — this app seems to be part of a workspace`;
    if (readManifest(join(dir, 'package.json'))?.workspaces !== undefined) return `${join(dir, 'package.json')} has "workspaces" — this app seems to be part of a workspace`;
  }
  return undefined;
}

/**
 * The package manager of the app in `root`, by the lockfile in `root` itself and the `packageManager` field of its `package.json`.
 * Only pnpm and npm are run. Refused (fail closed): a workspace around the app or rooted in it, a lockfile of another package manager,
 * two lockfiles the field does not settle, and a field that names anything but the manager the lockfile belongs to.
 */
export function detectPackageManager(root: string): PackageManagerChoice {
  const found = lockfilesIn(root);
  const refuse = (reason: PackageManagerRefusal, message: string, files: string[] = found, fix?: string): PackageManagerChoice => ({ ok: false, reason, message, ...(fix === undefined ? {} : { fix }), found: files });
  const manifest = readManifest(join(root, 'package.json'));
  if (manifest === undefined || Array.isArray(manifest)) return refuse('unreadable', 'package.json could not be read', found, 'correct package.json so that it is one JSON object');
  const workspace = workspaceProblem(root);
  if (workspace !== undefined) return refuse('workspace', workspace);
  if (found.length === 0) {
    for (const dir of ancestors(root)) {
      const above = lockfilesIn(dir);
      if (above.length > 0) return refuse('workspace', `the lockfile ${join(dir, above[0]!)} is in a parent directory — this app seems to be part of a workspace`, above);
    }
    return refuse('no-lockfile', 'there is no lockfile next to package.json');
  }
  const pnpm = found.filter((name) => PNPM_LOCK.includes(name));
  const npm = found.filter((name) => NPM_LOCK.includes(name));
  if (pnpm.length + npm.length === 0) return refuse('unsupported', `${found.join(', ')} ${found.length === 1 ? 'belongs' : 'belong'} to a package manager Marmeon does not run`);
  if (found.some((name) => OTHER_LOCK.includes(name))) return refuse('ambiguous', `the lockfiles ${found.join(', ')} name more than one package manager`);

  const field = manifest.packageManager;
  const declared = field === undefined ? undefined : typeof field === 'string' ? (/^([^@]+)(?:@|$)/.exec(field)?.[1] ?? '') : null;
  if (declared === null) return refuse('conflict', '"packageManager" in package.json is not a string');
  if (pnpm.length > 0 && npm.length > 0) {
    if (declared === 'pnpm') return { ok: true, name: 'pnpm', lockfile: pnpm[0]! };
    if (declared === 'npm') return { ok: true, name: 'npm', lockfile: npm[0]! };
    if (declared !== undefined) return refuse('conflict', `package.json names ${declared} in "packageManager", and the lockfiles ${found.join(', ')} belong to pnpm and npm`);
    return refuse('ambiguous', `the lockfiles ${found.join(', ')} name two package managers — set "packageManager" in package.json to one of them`);
  }
  const name: PackageManagerName = pnpm.length > 0 ? 'pnpm' : 'npm';
  if (declared !== undefined && declared !== name) return refuse('conflict', `package.json names ${declared} in "packageManager", the lockfile ${found[0]} belongs to ${name}`);
  return { ok: true, name, lockfile: (name === 'pnpm' ? pnpm : npm)[0]! };
}

export type DependencyGroup = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface InstallSpec {
  readonly name: string;
  readonly version: Version;
}

/** An {@link InstallSpec} with the group `package.json` lists it in. */
export interface GroupedInstallSpec extends InstallSpec {
  readonly group: DependencyGroup;
}

/** `name@version` for one package, the only way a target joins a command line. Throws on a name that is not a framework package or a version that is not exact: both come from an allow-list or the app's own manifest, so another value is a mistake in the caller. */
function target({ name, version }: InstallSpec): string {
  if (!FRAMEWORK_NAME.test(name)) throw new Error(`"${name}" is not a framework package`);
  if (!EXACT_VERSION.test(version.text)) throw new Error(`"${version.text}" is not an exact version`);
  return `${name}@${version.text}`;
}

const GROUP_ORDER = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Throws for a spec whose group an install does not write to (`peerDependencies`, or anything a cast or a JavaScript caller brings): it would otherwise be left out without a word. */
function checkGroups(specs: readonly GroupedInstallSpec[]): void {
  for (const { name, group } of specs) {
    if (!GROUP_ORDER.includes(group)) throw new Error(`${name} is in "${String(group)}", which an install does not write to`);
  }
}

/**
 * The argument lists that install `specs` exactly, one list per group a spec belongs to (a package stays in the group `package.json`
 * lists it in), each argument its own string and never through a shell. Throws like {@link target}.
 * npm gets `--include=dev` because its configuration may omit devDependencies, which would prune what the app needs (pnpm 12 does not
 * prune under `npm_config_production` or `NPM_CONFIG_OMIT`, probed); `--no-fund` only quiets the funding notice.
 */
export function installArgs(pm: PackageManagerName, specs: readonly GroupedInstallSpec[]): string[][] {
  checkGroups(specs);
  const lists: string[][] = [];
  for (const group of GROUP_ORDER) {
    const targets = specs.filter((spec) => spec.group === group).map(target);
    if (targets.length === 0) continue;
    // Always an explicit group: a `save-dev=true` in `.npmrc` or the environment would otherwise move the package out of `dependencies`.
    const flag = [group === 'devDependencies' ? '--save-dev' : group === 'optionalDependencies' ? '--save-optional' : '--save-prod'];
    lists.push(pm === 'pnpm' ? ['add', '--save-exact', ...flag, ...targets] : ['install', '--save-exact', ...flag, '--include=dev', '--no-fund', ...targets]);
  }
  return lists;
}

// yarn and bun have no flag that forces `dependencies` over a configured default, so their production command carries none.
const MANUAL: Record<'pnpm' | 'npm' | 'yarn' | 'bun', { add: string; flags: Record<DependencyGroup, string> }> = {
  pnpm: { add: 'pnpm add -E', flags: { dependencies: ' -P', devDependencies: ' -D', optionalDependencies: ' -O' } },
  npm: { add: 'npm install --save-exact', flags: { dependencies: ' --save-prod', devDependencies: ' --save-dev', optionalDependencies: ' --save-optional' } },
  yarn: { add: 'yarn add -E', flags: { dependencies: '', devDependencies: ' --dev', optionalDependencies: ' --optional' } },
  bun: { add: 'bun add --exact', flags: { dependencies: '', devDependencies: ' --dev', optionalDependencies: ' --optional' } },
};

/**
 * The install commands, as text for a refusal (printed, never run), one per package manager among the lockfiles in `found` and per group.
 * Empty when `found` has no lockfile of pnpm, npm, yarn or bun (`no-lockfile`, a `workspace` with no lockfile known, deno.lock and vlt-lock.json give none). Throws like {@link target}.
 */
export function manualCommands(found: readonly string[], specs: readonly GroupedInstallSpec[]): string[] {
  checkGroups(specs);
  const commands: string[] = [];
  for (const name of found) {
    const manager = PNPM_LOCK.includes(name) ? 'pnpm' : NPM_LOCK.includes(name) ? 'npm' : name === 'yarn.lock' ? 'yarn' : name === 'bun.lock' || name === 'bun.lockb' ? 'bun' : undefined;
    if (manager === undefined) continue;
    for (const group of GROUP_ORDER) {
      const targets = specs.filter((spec) => spec.group === group).map(target);
      if (targets.length === 0) continue;
      const command = `${MANUAL[manager].add}${MANUAL[manager].flags[group]} ${targets.join(' ')}`;
      if (!commands.includes(command)) commands.push(command);
    }
  }
  return commands;
}

/** What a package manager is run with: the app's environment without `NODE_ENV` (production prunes devDependencies) and `MARMEON_*` (the framework's own, the dotenv marker among them). */
export function packageManagerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'NODE_ENV' || key.startsWith('MARMEON_')) continue;
    clean[key] = value;
  }
  return clean;
}

/** The most a captured package manager may print. */
const MAX_CAPTURE = 4 * 1024 * 1024;

const OWN_GROUP = process.platform !== 'win32';

export interface PackageManagerRun {
  readonly cwd: string;
  /**
   * A person is at the terminal: stdin reaches the package manager (its own question stays theirs to answer), and it stays in the terminal's
   * process group. Such a run has no group of its own: a Ctrl-C reaches the whole foreground group, but an abort through `signal` stops the
   * package manager only, and what its lifecycle scripts started may go on. The caller must not restore files before the run has settled.
   */
  readonly interactive: boolean;
  /** `inherit` shows its output, `stderr` moves it to stderr, `capture` returns it. The result's `stdout` is raw text of someone else: print it through the command output. */
  readonly stdout: 'inherit' | 'stderr' | 'capture';
  /** Ends the run after this long. Captured runs default to one minute; an `inherit` or `stderr` run (an install) has none unless the caller passes one. */
  readonly timeoutMs?: number;
  /** Ends the run when it aborts: the child's group gets SIGTERM, then SIGKILL after `graceMs`, and the call rejects. */
  readonly signal?: AbortSignal;
  /** How long a stopped child has before SIGKILL (default 5 s). */
  readonly graceMs?: number;
  /** How long the pipes of an exited child may stay open before they are closed (default 2 s). */
  readonly drainMs?: number;
}

/**
 * Runs pnpm or npm. A class so that a test can replace it in the container. A run nobody watches (not `interactive`) leads a process group of
 * its own: the run settles only after the group is gone, and every signal reaches the whole group. An interactive run stays in the terminal's
 * group, and an abort through `signal` stops the package manager only (see {@link PackageManagerRun.interactive}).
 */
export class PackageManagerProcess {
  run(name: PackageManagerName, args: readonly string[], options: PackageManagerRun): Promise<{ code: number; stdout: string }> {
    return runInGroup(name, name, args, packageManagerEnv(), options);
  }
}

/**
 * Runs `command` as `label` says in the messages, with `env`, in the way {@link PackageManagerProcess} runs a package manager: no shell, a process group of its own
 * unless `interactive`, signals passed on, and a result only after the whole group is gone. Also what runs the installed `marmeon` of the app after an upgrade.
 */
export function runInGroup(label: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv, options: PackageManagerRun): Promise<{ code: number; stdout: string }> {
  const { timeoutMs = options.stdout === 'capture' ? 60_000 : undefined, graceMs = 5_000, drainMs = 2_000, signal } = options;
  if (signal?.aborted) return Promise.reject(new Error(`${label} was not started: the run was aborted`));
  return new Promise((resolve, reject) => {
    const out = options.stdout === 'capture' ? 'pipe' : options.stdout === 'stderr' ? 2 : 'inherit';
    // An argument array and no shell: every argument reaches the package manager as the one string it is. A run nobody watches leads a
    // process group of its own, so a signal reaches what the package manager started; an interactive one stays in the terminal's group.
    const detached = OWN_GROUP && !options.interactive;
    const child = spawn(command, args, { cwd: options.cwd, env, shell: false, detached, stdio: [options.interactive ? 'inherit' : 'ignore', out, 'inherit'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let exit: { code: number } | undefined;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let reaped = false;
    let leaderExited = false;
    // Set once the group is known to be gone (or was sent its SIGKILL after the leader exited): its id may be reused from then on, so nothing is sent to it again.
    let groupGone = false;
    const signalTree = (kind: 'SIGTERM' | 'SIGKILL') => {
      if (child.pid === undefined || groupGone) return;
      try {
        if (detached) process.kill(-child.pid, kind);
        else child.kill(kind);
        if (kind === 'SIGKILL' && leaderExited) groupGone = true;
      } catch {
        // ESRCH or EPERM: the group ended in the meantime.
        groupGone = true;
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      clearTimeout(pollTimer);
      signal?.removeEventListener('abort', aborted);
      for (const [forward, handler] of forwarded) process.off(forward, handler);
      if (failure) reject(failure);
      else resolve({ code: exit?.code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    const settleWhenReady = () => {
      if (closed && reaped) finish();
    };
    // What is left of the group after its leader exited: one SIGTERM, then polling for the group to go. A live group pins its id (POSIX), so
    // the polling bounds the window in which the id could be reused to one poll interval; SIGKILL goes out only if the group answered every poll for `graceMs`.
    const onReaped = () => {
      reaped = true;
      // A grandchild holding the pipe must not keep this waiting.
      drainTimer ??= setTimeout(abandon, drainMs);
      settleWhenReady();
    };
    const reapGroup = () => {
      signalTree('SIGTERM');
      if (groupGone) {
        onReaped();
        return;
      }
      let polls = 0;
      const attempts = Math.max(1, Math.ceil(graceMs / 100));
      const poll = () => {
        try {
          process.kill(-child.pid!, 0);
        } catch {
          groupGone = true;
        }
        if (!groupGone && ++polls >= attempts) signalTree('SIGKILL');
        if (groupGone) {
          onReaped();
          return;
        }
        pollTimer = setTimeout(poll, 100);
      };
      pollTimer = setTimeout(poll, 100);
    };
    const stop = (because: Error) => {
      failure ??= because;
      signalTree('SIGTERM');
      killTimer ??= setTimeout(() => {
        // After the leader exited the group is `reapGroup`'s to end.
        if (!leaderExited) signalTree('SIGKILL');
      }, graceMs);
    };
    // Nothing may keep a pipe: close the pipes and give the result (no signal: the group was dealt with, or its id may be reused).
    const abandon = () => {
      child.stdout?.destroy();
      finish();
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop(new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const aborted = () => stop(new Error(`${label} was stopped: the run was aborted`));
    signal?.addEventListener('abort', aborted, { once: true });
    // A run in a group of its own does not get the terminal's Ctrl-C: pass the signals the CLI receives on to the group, and stay alive to restore.
    const forwarded = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((forward) => [forward, () => stop(new Error(`${label} was stopped by ${forward}`))] as const);
    if (detached) for (const [forward, handler] of forwarded) process.on(forward, handler);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CAPTURE) {
        chunks.length = 0;
        stop(new Error(`${label} printed more than ${MAX_CAPTURE / 1024 / 1024} MiB`));
        return;
      }
      if (failure === undefined) chunks.push(chunk);
    });
    child.once('error', (error) => {
      failure ??= error;
      finish();
    });
    child.once('exit', (code, signal) => {
      exit = { code: code ?? (signal ? 1 : 0) };
      leaderExited = true;
      if (detached) reapGroup();
      else onReaped();
    });
    // `close`, not `exit`: the pipes are drained by then. The run settles when the group is dealt with as well, so nothing outlives it.
    child.once('close', () => {
      closed = true;
      settleWhenReady();
    });
  });
}

/**
 * The exact bytes of `package.json`, the lockfile and the `extra` files (names in `root`, such as `pnpm-workspace.yaml`, which pnpm may write
 * during an install), so that a failed install can be taken back. `restore` tries every file and throws one error naming each it could not
 * write. It never deletes `package.json` or the lockfile; an `extra` file that did not exist when the snapshot was taken and is a regular file by now was made by the install, and is removed.
 */
export function snapshotInstallFiles(root: string, lockfile: string, extra: readonly string[] = []): { restore(): void } {
  const files = ['package.json', lockfile].map((name) => ({ name, path: join(root, name), bytes: readFileSync(join(root, name)) as Buffer | undefined }));
  for (const name of extra) {
    // A name, never a path: the file that is removed on restore stays inside `root`.
    if (name === '' || name === '.' || name === '..' || name !== basename(name) || name.includes('/') || name.includes('\\')) throw new Error(`"${name}" is not a file name in the app's root`);
    let bytes: Buffer | undefined;
    try {
      bytes = readFileSync(join(root, name));
    } catch (error) {
      // Only a missing file is "not there"; one that cannot be read must stop the upgrade before it changes anything.
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
    files.push({ name, path: join(root, name), bytes });
  }
  return {
    restore() {
      const failed: string[] = [];
      for (const { name, path, bytes } of files) {
        try {
          if (bytes !== undefined) writeFileSync(path, bytes);
          else if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) unlinkSync(path);
        } catch {
          failed.push(name);
        }
      }
      if (failed.length > 0) throw new Error(`${failed.join(' and ')} could not be restored`);
    },
  };
}
