import { chmodSync, existsSync, mkdirSync, rmSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Container } from '@marmeon/core';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { runCommand } from './command.ts';
import { AddCommand } from './commands/add.ts';
import { PackageManagerProcess, type PackageManagerName } from './framework/package-manager.ts';
import { Output } from './output.ts';
import { noPrompt } from './prompt.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** An app at `version` with `@marmeon/core`, `@marmeon/http` and a lockfile of `lockfile` installed. */
function app({ version = '1.1.0', lockfile = 'pnpm-lock.yaml', extra = {} }: { version?: string; lockfile?: string; extra?: Record<string, unknown> } = {}): string {
  const root = realpathSync(tempDir('marmeon-add-'));
  write(join(root, 'package.json'), { name: 'app', dependencies: { '@marmeon/core': version, '@marmeon/http': version }, ...extra });
  for (const name of ['@marmeon/core', '@marmeon/http']) write(join(root, 'node_modules', name, 'package.json'), { name, version });
  write(join(root, lockfile), 'lockfile: 1\n');
  return root;
}

const bytes = (root: string, ...files: string[]) => files.map((file) => readFileSync(join(root, file), 'utf8'));

interface Call {
  readonly name: PackageManagerName;
  readonly args: readonly string[];
  readonly interactive: boolean;
}

/** Stands in for pnpm and npm: writes what an install writes (the manifest, the lockfile, `node_modules`), then ends as `mode` says. */
class FakePackageManager extends PackageManagerProcess {
  readonly calls: Call[] = [];
  mode: 'ok' | 'fail' | 'reject' = 'ok';
  /** What each call does instead of `mode`, in order: `signal` finishes the install and then sends SIGINT to the process, as Ctrl-C would. */
  script: ('ok' | 'fail' | 'reject' | 'signal')[] = [];
  /** What the install writes before the version of a package. */
  specPrefix = '';
  /** The signal a `signal` call sends. */
  signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' = 'SIGINT';
  /** Leaves `package.json` read-only after the install wrote it. */
  readOnly = false;

  readonly root: string;

  constructor(root: string) {
    super();
    this.root = root;
  }

  override async run(name: PackageManagerName, args: readonly string[], options: Parameters<PackageManagerProcess['run']>[2]): Promise<{ code: number; stdout: string }> {
    const mode = this.script[this.calls.length] ?? this.mode;
    this.calls.push({ name, args, interactive: options.interactive });
    const manifest = JSON.parse(readFileSync(join(this.root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const group = args.includes('--save-dev') ? 'devDependencies' : 'dependencies';
    for (const target of args.filter((arg) => arg.lastIndexOf('@') > 0)) {
      const at = target.lastIndexOf('@');
      const [package_, version] = [target.slice(0, at), target.slice(at + 1)];
      (manifest[group] ??= {})[package_] = `${this.specPrefix}${version}`;
      write(join(this.root, 'node_modules', package_, 'package.json'), { name: package_, version });
    }
    write(join(this.root, 'package.json'), manifest);
    writeFileSync(join(this.root, name === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'), 'lockfile: changed\n', 'utf8');
    if (this.readOnly) chmodSync(join(this.root, 'package.json'), 0o444);
    if (mode === 'reject') throw new Error(`${name} was stopped by SIGINT`);
    if (mode === 'signal') process.emit(this.signal);
    return { code: mode === 'fail' ? 1 : 0, stdout: '' };
  }
}

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => void out.push(String(text))) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => void out.push(String(text))) as never);
  return out;
}

/** Runs `marmeon add argv` in `root`, with the fake package manager and a recorded `spawn`. */
async function add(
  root: string,
  argv: string[],
  { mode = 'ok', spawned = {}, interactive = false, configure }: { mode?: FakePackageManager['mode']; spawned?: Record<string, number>; interactive?: boolean; configure?: (fake: FakePackageManager) => void } = {},
) {
  const fake = new FakePackageManager(root);
  fake.mode = mode;
  configure?.(fake);
  const container = new Container();
  container.instance(PackageManagerProcess, fake);
  const spawns: string[][] = [];
  const out = capture();
  const code = await runCommand(container, AddCommand, argv, {
    output: new Output(),
    root,
    prompt: { ...noPrompt, interactive },
    spawn: async (...args) => {
      spawns.push(args);
      return spawned[args[0]!] ?? 0;
    },
  });
  return { code, fake, spawns, text: out.join('') };
}

describe('marmeon add', () => {
  it('installs a package at the version of the app, discovers it and publishes nothing for a package without migrations', async () => {
    const root = app();
    const { code, fake, spawns, text } = await add(root, ['redis']);
    expect(code).toBe(0);
    expect(fake.calls.map(({ name, args }) => [name, args])).toEqual([['pnpm', ['add', '--save-exact', '--save-prod', '@marmeon/redis@1.1.0']]]);
    expect(spawns).toEqual([['discover']]);
    expect(text).toContain('Added @marmeon/redis@1.1.0');
    expect(text).toContain('marmeon docs redis');
    expect(text).not.toContain('marmeon migrate');
  });

  it('publishes the migrations of a package that ships some, and points to migrate', async () => {
    const { code, spawns, text } = await add(app(), ['@marmeon/session']);
    expect(code).toBe(0);
    expect(spawns).toEqual([['discover'], ['publish', '@marmeon/session']]);
    expect(text).toContain('Next: marmeon migrate');
  });

  it('installs a development package with --save-dev', async () => {
    const { code, fake } = await add(app(), ['testing']);
    expect(code).toBe(0);
    expect(fake.calls[0]!.args).toEqual(['add', '--save-exact', '--save-dev', '@marmeon/testing@1.1.0']);
  });

  it('installs the packages of both groups with one call each, and takes the full name as well as the short one', async () => {
    const { code, fake } = await add(app(), ['@marmeon/redis', 'testing', 'redis']);
    expect(code).toBe(0);
    expect(fake.calls.map(({ args }) => args.slice(-1)[0])).toEqual(['@marmeon/redis@1.1.0', '@marmeon/testing@1.1.0']);
  });

  it('takes a prerelease version of the app', async () => {
    const { code, fake } = await add(app({ version: '1.2.0-rc.1' }), ['redis']);
    expect(code).toBe(0);
    expect(fake.calls[0]!.args.slice(-1)).toEqual(['@marmeon/redis@1.2.0-rc.1']);
  });

  it('runs npm for an npm lockfile', async () => {
    const { code, fake } = await add(app({ lockfile: 'package-lock.json' }), ['redis']);
    expect(code).toBe(0);
    expect(fake.calls.map(({ name, args }) => [name, args])).toEqual([['npm', ['install', '--save-exact', '--save-prod', '--include=dev', '--no-fund', '@marmeon/redis@1.1.0']]]);
  });

  it('installs a package named marmeon into dependencies', async () => {
    const { code, text } = await add(app(), ['marmeon', '--dry-run']);
    expect(code).toBe(0);
    expect(text).toContain('pnpm add --save-exact --save-prod marmeon@1.1.0');
  });

  it('lets stdin reach the package manager only when a person is at the terminal', async () => {
    const { fake } = await add(app(), ['redis'], { interactive: true });
    expect(fake.calls[0]!.interactive).toBe(true);
  });

  it('keeps stdin from the package manager without a person at the terminal', async () => {
    const { fake } = await add(app(), ['redis']);
    expect(fake.calls[0]!.interactive).toBe(false);
  });

  describe('refuses a name that is not in the list of the framework with a CommandArgumentsError, and runs no package manager', () => {
    it.each(['redis@2.0.0', '@evil/redis', '../x', 'file:x', 'unknown', 'Redis', '@marmeon/unknown', '@marmeon/../x', 'redis --registry=http://x', '', 'create-marmeon', '@marmeon/create-marmeon'])('%j', async (name) => {
      const root = app();
      const fake = new FakePackageManager(root);
      const container = new Container();
      container.instance(PackageManagerProcess, fake);
      const error = await runCommand(container, AddCommand, ['--', name], { output: new Output(), root, spawn: async () => 0 }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'CommandArgumentsError' });
      expect(fake.calls).toEqual([]);
    });

    it('takes a value that looks like an option only after `--`, and an option unknown to the command is refused', async () => {
      const root = app();
      const container = new Container();
      const fake = new FakePackageManager(root);
      container.instance(PackageManagerProcess, fake);
      await expect(runCommand(container, AddCommand, ['--registry=http://x'], { output: new Output(), root, spawn: async () => 0 })).rejects.toMatchObject({ name: 'CommandArgumentsError' });
      await expect(runCommand(container, AddCommand, ['--', '--registry=http://x'], { output: new Output(), root, spawn: async () => 0 })).rejects.toMatchObject({ name: 'CommandArgumentsError' });
      expect(fake.calls).toEqual([]);
    });

    it('suggests close names', async () => {
      const root = app();
      const container = new Container();
      container.instance(PackageManagerProcess, new FakePackageManager(root));
      await expect(runCommand(container, AddCommand, ['redsi'], { output: new Output(), root, spawn: async () => 0 })).rejects.toThrow('Did you mean: @marmeon/redis');
    });

    it('needs a name', async () => {
      const root = app();
      const container = new Container();
      container.instance(PackageManagerProcess, new FakePackageManager(root));
      await expect(runCommand(container, AddCommand, [], { output: new Output(), root, spawn: async () => 0 })).rejects.toMatchObject({ name: 'CommandArgumentsError' });
    });
  });

  it('refuses an app whose framework packages are in different versions', async () => {
    const root = app();
    write(join(root, 'node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: '1.0.0' });
    const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
    const { code, fake, spawns, text } = await add(root, ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(spawns).toEqual([]);
    expect(text).toContain('marmeon check --only=packages');
    expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
  });

  it('refuses a framework package that is not from the registry', async () => {
    const root = app({ extra: { dependencies: { '@marmeon/core': '1.1.0', '@marmeon/http': 'workspace:*' } } });
    const { code, fake } = await add(root, ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a package that is listed only as a peer, and does not guess a group for it', async () => {
    const root = app({ extra: { peerDependencies: { '@marmeon/redis': '1.1.0' } } });
    write(join(root, 'node_modules/@marmeon/redis/package.json'), { name: '@marmeon/redis', version: '1.1.0' });
    const { code, fake, text } = await add(root, ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(text).toContain('peerDependencies');
  });

  it('tells a yarn app the command to run, and runs nothing', async () => {
    const root = app({ lockfile: 'yarn.lock' });
    const { code, fake, spawns, text } = await add(root, ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(spawns).toEqual([]);
    expect(text).toContain('yarn add -E @marmeon/redis@1.1.0');
  });

  it('says what to do when no command can be named for the lockfile', async () => {
    const { code, fake, text } = await add(app({ lockfile: 'deno.lock' }), ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(text).toContain('with your package manager');
  });

  it('restores package.json and the lockfile when the install fails, and says how to bring node_modules back', async () => {
    const root = app();
    const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
    const { code, spawns, text } = await add(root, ['redis'], { mode: 'fail' });
    expect(code).toBe(1);
    expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
    expect(spawns).toEqual([]);
    expect(text).toContain('pnpm install');
    expect(text).toContain('pnpm approve-builds');
  });

  it('restores the files when the package manager rejects as well', async () => {
    const root = app();
    const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
    const { code, text } = await add(root, ['redis'], { mode: 'reject' });
    expect(code).toBe(1);
    expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
    expect(text).toContain('stopped by SIGINT');
  });

  it('writes nothing and runs nothing with --dry-run, and names the commands', async () => {
    const root = app();
    const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
    const { code, fake, spawns, text } = await add(root, ['session', 'testing', '--dry-run']);
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(spawns).toEqual([]);
    expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
    expect(text).toContain('pnpm add --save-exact --save-prod @marmeon/session@1.1.0');
    expect(text).toContain('pnpm add --save-exact --save-dev @marmeon/testing@1.1.0');
    expect(text).toContain('marmeon publish @marmeon/session');
  });

  it('skips a package the app has, and does nothing when none is left', async () => {
    const { code, fake, spawns, text } = await add(app(), ['http', '@marmeon/core']);
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(spawns).toEqual([]);
    expect(text).toContain('@marmeon/http is already installed (1.1.0)');
  });

  it('installs only the packages the app lacks', async () => {
    const { code, fake } = await add(app(), ['http', 'redis']);
    expect(code).toBe(0);
    expect(fake.calls.map(({ args }) => args.slice(-1)[0])).toEqual(['@marmeon/redis@1.1.0']);
  });

  it('fails without restoring when the package manager left a package in another version', async () => {
    const root = app();
    class Older extends FakePackageManager {
      override async run(...parameters: Parameters<FakePackageManager['run']>) {
        const result = await super.run(...parameters);
        write(join(root, 'node_modules/@marmeon/redis/package.json'), { name: '@marmeon/redis', version: '1.0.0' });
        return result;
      }
    }
    const fake = new Older(root);
    const container = new Container();
    container.instance(PackageManagerProcess, fake);
    const out = capture();
    const spawns: string[][] = [];
    const code = await runCommand(container, AddCommand, ['redis'], { output: new Output(), root, spawn: async (...args) => {
        spawns.push(args);
        return 0;
      } });
    expect(code).toBe(1);
    expect(spawns).toEqual([]);
    expect(out.join('')).toContain('The packages are installed, but');
    expect(out.join('')).toContain('docs/releases.md#the-first-day-after-a-release');
    // The install itself finished: its files stay.
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('@marmeon/redis');
  });

  it('fails when discovery fails, and when publishing fails names what to run', async () => {
    const discovery = await add(app(), ['session'], { spawned: { discover: 1 } });
    expect(discovery.code).toBe(1);
    expect(discovery.text).toContain('marmeon discover');
    expect(discovery.spawns).toEqual([['discover']]);
    expect(discovery.text).toContain('marmeon publish @marmeon/session');
    expect(discovery.text).toContain('marmeon migrate');
    const publish = await add(app(), ['session', 'queue'], { spawned: { publish: 1 } });
    expect(publish.code).toBe(1);
    expect(publish.text).toContain('marmeon publish @marmeon/session');
    expect(publish.text).toContain('marmeon publish @marmeon/queue');
  });
  it('fails when the manager wrote a range, though the installed version is right, and does not restore', async () => {
    const root = app();
    const { code, spawns, text } = await add(root, ['redis'], { configure: (fake) => void (fake.specPrefix = '^') });
    expect(code).toBe(1);
    expect(spawns).toEqual([]);
    expect(text).toContain('not installed at the version 1.1.0 of your app');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('^1.1.0');
  });

  it('installs nothing when the files cannot be read to take a failed install back', async () => {
    const root = app();
    rmSync(join(root, 'pnpm-lock.yaml'));
    mkdirSync(join(root, 'pnpm-lock.yaml'));
    const { code, fake, spawns, text } = await add(root, ['redis']);
    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(spawns).toEqual([]);
    expect(text).toContain('Nothing was installed');
  });

  it('names the files to put back from version control when they cannot be restored, and does not throw', async () => {
    const root = app();
    const { code, text } = await add(root, ['redis'], { mode: 'fail', configure: (fake) => void (fake.readOnly = true) });
    expect(code).toBe(1);
    expect(text).toContain('package.json could not be restored');
    expect(text).toContain('version control');
  });

  describe('signals', () => {
    const counts = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal));

    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('stops after the group that was running when %s came, takes everything back and leaves no listener', async (signal) => {
      const root = app();
      const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
      const listeners = counts();
      const { code, fake, spawns } = await add(root, ['redis', 'testing'], {
        configure: (fake) => {
          fake.script = ['signal'];
          fake.signal = signal;
        },
      });
      expect(code).toBe(1);
      expect(fake.calls).toHaveLength(1);
      expect(spawns).toEqual([]);
      expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
      expect(counts()).toEqual(listeners);
    });

    it('keeps its listeners until the files are back, so a second signal does not end the process half-way', async () => {
      const root = app();
      const listeners = counts();
      const seen: number[] = [];
      const out: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => void (out.push(String(text)), text.includes('did not finish') && seen.push(process.listenerCount('SIGINT')))) as never);
      vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => void (out.push(String(text)), text.includes('are as they were') && seen.push(process.listenerCount('SIGINT')))) as never);
      const fake = new FakePackageManager(root);
      fake.script = ['signal'];
      const container = new Container();
      container.instance(PackageManagerProcess, fake);
      const code = await runCommand(container, AddCommand, ['redis'], { output: new Output(), root, spawn: async () => 0 });
      expect(code).toBe(1);
      // Once before the restore (the message of the failure) and once after it.
      expect(seen).toEqual([listeners[0]! + 1, listeners[0]! + 1]);
      expect(counts()).toEqual(listeners);
    });

    it('takes back the changes of both groups when the second fails', async () => {
      const root = app();
      const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
      const { code, fake } = await add(root, ['redis', 'testing'], { configure: (fake) => void (fake.script = ['ok', 'fail']) });
      expect(code).toBe(1);
      expect(fake.calls).toHaveLength(2);
      expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
    });

    it.each([['success', 'ok'], ['failure', 'fail'], ['rejection', 'reject']] as const)('leaves no listener after a %s', async (_, mode) => {
      const listeners = counts();
      await add(app(), ['redis'], { mode });
      expect(counts()).toEqual(listeners);
    });
  });
});

// Ctrl-C while the package manager runs: a real child process on a PATH of its own, the real PackageManagerProcess, the real signal handling.
describe('marmeon add, interrupted', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function until(done: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  it('stops the package manager, waits until it has ended, restores the files and exits with 1', async () => {
    const root = app();
    const before = bytes(root, 'package.json', 'pnpm-lock.yaml');
    const bin = realpathSync(tempDir('marmeon-add-bin-'));
    const pidFile = join(bin, 'pid');
    // The stand-in writes the manifest as an install does, then ignores nothing: on SIGTERM it takes a moment and writes the manifest once more.
    // A restore that does not wait for it would be written over.
    writeFileSync(
      join(bin, 'pnpm'),
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        // The pid first, so the test can always end the process; the handler before the files, which are what the test waits for.
        `fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));`,
        `fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
        'setTimeout(() => process.exit(0), 20000);',
        "process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync('package.json', '{\"late\": \"write\"}'); process.exit(143); }, 300));",
        "fs.writeFileSync('package.json', '{\"half\": \"done\"}');",
        "fs.writeFileSync('pnpm-lock.yaml', 'half done');",
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    vi.stubEnv('PATH', bin);
    let pid: number | undefined;
    onTestFinished(() => {
      // The stand-in writes its pid first: a test that failed before reading it still finds it.
      const target = pid ?? (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined);
      if (target === undefined) return;
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Gone already.
      }
    });
    const out = capture();
    // The container builds the real package manager process.
    const running = runCommand(new Container(), AddCommand, ['redis'], { output: new Output(), root, spawn: async () => 0 });
    expect(await until(() => existsSync(pidFile))).toBe(true);
    pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await until(() => readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8') === 'half done')).toBe(true);
    process.emit('SIGINT');
    expect(await running).toBe(1);
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(bytes(root, 'package.json', 'pnpm-lock.yaml')).toEqual(before);
    expect(out.join('')).toContain('pnpm install');
  });
});
