import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { detectPackageManager, installArgs, manualCommands, PackageManagerProcess, snapshotInstallFiles } from './framework/package-manager.ts';
import { repo } from './__fixtures__/cli.js';
import { parseVersion, type Version } from './framework/versions.ts';

const version = (text: string): Version => parseVersion(text)!;

/** An app directory (`<outer>/app`) with `package.json` (extended by `manifest`), empty `lockfiles`, and `parent` files in `<outer>`. */
function app(lockfiles: readonly string[], manifest: object = {}, parent: Record<string, string> = {}): string {
  const outer = realpathSync(tempDir('marmeon-pm-'));
  const root = join(outer, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', ...manifest }));
  for (const name of lockfiles) writeFileSync(join(root, name), '');
  for (const [name, text] of Object.entries(parent)) writeFileSync(join(outer, name), text);
  return root;
}

describe('detectPackageManager', () => {
  it('chooses pnpm by its lockfile', () => {
    expect(detectPackageManager(app(['pnpm-lock.yaml']))).toEqual({ ok: true, name: 'pnpm', lockfile: 'pnpm-lock.yaml' });
  });

  it.each(['package-lock.json', 'npm-shrinkwrap.json'])('chooses npm by %s', (lockfile) => {
    expect(detectPackageManager(app([lockfile]))).toEqual({ ok: true, name: 'npm', lockfile });
  });

  it('prefers npm-shrinkwrap.json, which npm itself prefers', () => {
    expect(detectPackageManager(app(['package-lock.json', 'npm-shrinkwrap.json']))).toEqual({ ok: true, name: 'npm', lockfile: 'npm-shrinkwrap.json' });
  });

  it('accepts a packageManager field that agrees, with or without a version', () => {
    expect(detectPackageManager(app(['pnpm-lock.yaml'], { packageManager: 'pnpm@11.0.0' }))).toMatchObject({ ok: true, name: 'pnpm' });
    expect(detectPackageManager(app(['pnpm-lock.yaml'], { packageManager: 'pnpm' }))).toMatchObject({ ok: true, name: 'pnpm' });
  });

  it.each(['npm@11.0.0', 'yarn@4.0.0', 'yarn', 'vlt@1.0.0', 'deno@2.0.0', '@1.0.0', ''])('refuses the packageManager field %j next to a pnpm lockfile', (packageManager) => {
    expect(detectPackageManager(app(['pnpm-lock.yaml'], { packageManager }))).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('refuses a pnpm field next to an npm lockfile, and a field that is not a string', () => {
    expect(detectPackageManager(app(['package-lock.json'], { packageManager: 'pnpm@11.0.0' }))).toMatchObject({ ok: false, reason: 'conflict' });
    for (const packageManager of [1, null, ['npm'], { name: 'npm' }]) {
      expect(detectPackageManager(app(['package-lock.json'], { packageManager }))).toMatchObject({ ok: false, reason: 'conflict' });
      expect(detectPackageManager(app(['package-lock.json', 'pnpm-lock.yaml'], { packageManager }))).toMatchObject({ ok: false, reason: 'conflict' });
    }
  });

  it('lets the packageManager field pick between two lockfiles, and refuses without it', () => {
    const both = ['pnpm-lock.yaml', 'package-lock.json'];
    expect(detectPackageManager(app(both, { packageManager: 'npm@11.0.0' }))).toMatchObject({ ok: true, name: 'npm', lockfile: 'package-lock.json' });
    expect(detectPackageManager(app(both, { packageManager: 'pnpm@11.0.0' }))).toMatchObject({ ok: true, name: 'pnpm' });
    expect(detectPackageManager(app(both))).toMatchObject({ ok: false, reason: 'ambiguous', found: both });
    expect(detectPackageManager(app(both, { packageManager: 'yarn@4.0.0' }))).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it.each(['yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock', 'vlt-lock.json'])('refuses a lockfile of another package manager next to pnpm: %s', (other) => {
    expect(detectPackageManager(app(['pnpm-lock.yaml', other]))).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it.each(['yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock', 'vlt-lock.json'])('refuses %s as unsupported', (lockfile) => {
    expect(detectPackageManager(app([lockfile]))).toMatchObject({ ok: false, reason: 'unsupported', found: [lockfile] });
  });

  it('refuses an app whose lockfile is only in a parent directory, also two levels up', () => {
    expect(detectPackageManager(app([], {}, { 'pnpm-lock.yaml': '' }))).toMatchObject({ ok: false, reason: 'workspace', found: ['pnpm-lock.yaml'] });
    const nested = join(app([], {}, { 'pnpm-lock.yaml': '' }), 'deep');
    mkdirSync(nested);
    writeFileSync(join(nested, 'package.json'), '{}');
    expect(detectPackageManager(nested)).toMatchObject({ ok: false, reason: 'workspace' });
  });

  it('refuses an app without any lockfile', () => {
    expect(detectPackageManager(app([]))).toMatchObject({ ok: false, reason: 'no-lockfile' });
  });

  describe('workspaces', () => {
    it('refuses an app inside a pnpm workspace, with or without a lockfile of its own', () => {
      const parent = { 'pnpm-workspace.yaml': "packages:\n  - 'app'\n" };
      expect(detectPackageManager(app(['pnpm-lock.yaml'], {}, parent))).toMatchObject({ ok: false, reason: 'workspace' });
      expect(detectPackageManager(app([], {}, parent))).toMatchObject({ ok: false, reason: 'workspace' });
    });

    it('lets an app with a pnpm-workspace.yaml of its own through when a parent has one too, as that file decides', () => {
      const root = app(['pnpm-lock.yaml'], {}, { 'pnpm-workspace.yaml': "packages:\n  - 'app'\n" });
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'saveExact: true\n');
      expect(detectPackageManager(root)).toMatchObject({ ok: true, name: 'pnpm' });
    });

    it('refuses an app inside an npm workspace, with or without a lockfile of its own', () => {
      const parent = { 'package.json': JSON.stringify({ workspaces: ['app'] }) };
      expect(detectPackageManager(app(['package-lock.json'], {}, parent))).toMatchObject({ ok: false, reason: 'workspace' });
      expect(detectPackageManager(app([], {}, parent))).toMatchObject({ ok: false, reason: 'workspace' });
    });

    it('accepts a parent package.json without workspaces', () => {
      expect(detectPackageManager(app(['package-lock.json'], {}, { 'package.json': '{"name":"x"}' }))).toMatchObject({ ok: true, name: 'npm' });
    });

    it('refuses an app that is the root of a workspace, and a pnpm-workspace.yaml it cannot read', () => {
      expect(detectPackageManager(app(['package-lock.json'], { workspaces: ['packages/*'] }))).toMatchObject({ ok: false, reason: 'workspace' });
      const root = app(['pnpm-lock.yaml']);
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(detectPackageManager(root)).toMatchObject({ ok: false, reason: 'workspace' });
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: &p\n  - x\n');
      expect(detectPackageManager(root)).toMatchObject({ ok: false, reason: 'workspace', message: expect.stringContaining('could not be read') });
    });

    it('refuses a pnpm-workspace.yaml whose packages key is hidden by indentation', () => {
      const root = app(['pnpm-lock.yaml']);
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "  packages:\n    - 'apps/*'\n");
      expect(detectPackageManager(root)).toMatchObject({ ok: false, reason: 'workspace', message: expect.stringContaining('could not be read') });
    });

    it.each(['{ nope', '[]', '["x"]'])('refuses an app whose package.json is %j, with a fix', (text) => {
      const root = app(['pnpm-lock.yaml']);
      writeFileSync(join(root, 'package.json'), text);
      expect(detectPackageManager(root)).toMatchObject({ ok: false, reason: 'unreadable', fix: 'correct package.json so that it is one JSON object' });
    });

    it('accepts the pnpm-workspace.yaml the starter writes', async () => {
      const root = app(['pnpm-lock.yaml']);
      const template = (await import(pathToFileURL(join(repo, 'packages/create-marmeon/src/template.ts')).href)) as { SAVE_EXACT_PNPM: string };
      writeFileSync(join(root, 'pnpm-workspace.yaml'), `${template.SAVE_EXACT_PNPM}\n`);
      expect(detectPackageManager(root)).toMatchObject({ ok: true, name: 'pnpm' });
    });
  });
});

describe('installArgs', () => {
  const marmeon = (group: 'dependencies' | 'devDependencies' | 'optionalDependencies', name = 'marmeon') => ({ name, version: version('1.2.0'), group });

  it('builds one pnpm command per group, so a package stays where package.json lists it', () => {
    const specs = [marmeon('dependencies'), marmeon('devDependencies', '@marmeon/core'), marmeon('optionalDependencies', '@marmeon/redis')];
    expect(installArgs('pnpm', specs)).toEqual([
      ['add', '--save-exact', '--save-prod', 'marmeon@1.2.0'],
      ['add', '--save-exact', '--save-dev', '@marmeon/core@1.2.0'],
      ['add', '--save-exact', '--save-optional', '@marmeon/redis@1.2.0'],
    ]);
    expect(installArgs('pnpm', [marmeon('devDependencies'), marmeon('devDependencies', '@marmeon/core')])).toEqual([['add', '--save-exact', '--save-dev', 'marmeon@1.2.0', '@marmeon/core@1.2.0']]);
    expect(installArgs('pnpm', [])).toEqual([]);
  });

  it('asks npm to keep devDependencies, whatever its configuration omits, and leaves the audit summary on', () => {
    expect(installArgs('npm', [marmeon('dependencies')])).toEqual([['install', '--save-exact', '--save-prod', '--include=dev', '--no-fund', 'marmeon@1.2.0']]);
    expect(installArgs('npm', [marmeon('devDependencies')])).toEqual([['install', '--save-exact', '--save-dev', '--include=dev', '--no-fund', 'marmeon@1.2.0']]);
    expect(installArgs('npm', [marmeon('dependencies')]).flat()).not.toContain('--no-audit');
  });

  it('throws for a group an install does not write to, also when a cast or a JavaScript caller brings it', () => {
    const peer = { ...marmeon('dependencies'), group: 'peerDependencies' } as unknown as ReturnType<typeof marmeon>;
    expect(() => installArgs('pnpm', [peer])).toThrow('does not write to');
    expect(() => manualCommands(['yarn.lock'], [peer])).toThrow('does not write to');
  });

  it.each(['--registry=x', '@marmeon/core@file:x', 'left-pad', '@marmeon/Core', 'marmeon x', '@marmeon/'])('throws for the name %s', (name) => {
    expect(() => installArgs('pnpm', [marmeon('dependencies', name)])).toThrow('not a framework package');
  });

  it.each(['1.2.0 --foo', '^1.2.0', 'file:x', '', '1.2.0+.', '1.2.0+a..b', '1.2.0-a..b'])('throws for the version text %j, which is not exact', (text) => {
    expect(() => installArgs('npm', [{ ...marmeon('dependencies'), version: { ...version('1.2.0'), text } }])).toThrow('not an exact version');
  });
});

describe('manualCommands', () => {
  const marmeon = (group: 'dependencies' | 'devDependencies' | 'optionalDependencies', name = 'marmeon') => ({ name, version: version('1.2.0'), group });

  it('prints the command of each package manager found', () => {
    expect(manualCommands(['yarn.lock'], [marmeon('dependencies')])).toEqual(['yarn add -E marmeon@1.2.0']);
    expect(manualCommands(['bun.lockb', 'bun.lock'], [marmeon('dependencies')])).toEqual(['bun add --exact marmeon@1.2.0']);
    expect(manualCommands(['pnpm-lock.yaml', 'package-lock.json'], [marmeon('dependencies')])).toEqual(['pnpm add -E -P marmeon@1.2.0', 'npm install --save-exact --save-prod marmeon@1.2.0']);
  });

  it('prints one command per group with the flag of that group', () => {
    const specs = [marmeon('dependencies'), marmeon('devDependencies', '@marmeon/core'), marmeon('optionalDependencies', '@marmeon/redis')];
    expect(manualCommands(['pnpm-lock.yaml'], specs)).toEqual(['pnpm add -E -P marmeon@1.2.0', 'pnpm add -E -D @marmeon/core@1.2.0', 'pnpm add -E -O @marmeon/redis@1.2.0']);
    expect(manualCommands(['package-lock.json'], specs.slice(1))).toEqual(['npm install --save-exact --save-dev @marmeon/core@1.2.0', 'npm install --save-exact --save-optional @marmeon/redis@1.2.0']);
    expect(manualCommands(['yarn.lock'], specs.slice(1, 2))).toEqual(['yarn add -E --dev @marmeon/core@1.2.0']);
    expect(manualCommands(['bun.lock'], specs.slice(1, 2))).toEqual(['bun add --exact --dev @marmeon/core@1.2.0']);
  });

  it('is empty without a lockfile, and follows a refused detection', () => {
    expect(manualCommands([], [marmeon('dependencies')])).toEqual([]);
    const choice = detectPackageManager(app(['yarn.lock']));
    expect(choice.ok).toBe(false);
    expect(manualCommands(choice.ok ? [] : choice.found, [marmeon('devDependencies')])).toEqual(['yarn add -E --dev marmeon@1.2.0']);
  });

  it('throws for a name or version that is not allowed', () => {
    expect(() => manualCommands(['yarn.lock'], [{ ...marmeon('dependencies'), name: '--registry=x' }])).toThrow('not a framework package');
    expect(() => manualCommands(['yarn.lock'], [{ name: 'marmeon', group: 'dependencies', version: { ...version('1.2.0'), text: '1.2.0 --foo' } }])).toThrow('not an exact version');
  });
});

describe('snapshotInstallFiles', () => {
  it('writes back the exact bytes of package.json and the lockfile', () => {
    const root = app(['pnpm-lock.yaml']);
    writeFileSync(join(root, 'package.json'), '{"name":"app",\r\n "x": 1}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), Buffer.from([0, 255, 10, 13]));
    const before = [readFileSync(join(root, 'package.json')), readFileSync(join(root, 'pnpm-lock.yaml'))];
    const snapshot = snapshotInstallFiles(root, 'pnpm-lock.yaml');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed');
    snapshot.restore();
    expect(readFileSync(join(root, 'package.json')).equals(before[0]!)).toBe(true);
    expect(readFileSync(join(root, 'pnpm-lock.yaml')).equals(before[1]!)).toBe(true);
  });

  it('writes the file it can when the other one cannot be written, and names the one it could not', () => {
    const root = app(['pnpm-lock.yaml']);
    const snapshot = snapshotInstallFiles(root, 'pnpm-lock.yaml');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed');
    chmodSync(join(root, 'package.json'), 0o444);
    onTestFinished(() => chmodSync(join(root, 'package.json'), 0o644));
    // A user who may write through the mode (root) leaves the test nothing to prove.
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      return;
    } catch {
      // As intended.
    }
    expect(() => snapshot.restore()).toThrow('package.json could not be restored');
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('');
  });
});

describe('PackageManagerProcess', () => {
  interface Fake {
    readonly bin: string;
    readonly record: string;
    readonly cwd: string;
  }

  interface Recorded {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    pid: number;
    fds: { readonly [fd: number]: { dev: number; ino: number } };
    grandchild?: number;
  }

  const PACKAGE_MANAGER = pathToFileURL(join(repo, 'packages/cli/src/framework/package-manager.ts')).href;

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** What the stand-in wrote, or nothing when it did not run (yet). */
  const recorded = (fake: Fake): Recorded | undefined => {
    try {
      return JSON.parse(readFileSync(fake.record, 'utf8')) as Recorded;
    } catch {
      // Not written yet; the stand-in renames a complete file onto it, so a partial read does not happen.
      return undefined;
    }
  };

  /** Waits (by counting attempts, not by the clock) until `done` holds. */
  async function until(done: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  const gone = (pid: number) => until(() => !alive(pid));

  const killQuietly = (pid: number | undefined) => {
    if (pid === undefined) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };

  /**
   * A `pnpm` on a PATH of its own that records its arguments, environment, directory, pid and the identity of descriptors 0 to 2, then
   * runs `body` (which may be a function of the record's path). It ends itself after 20 s, and the test kills what is left.
   */
  function fakePackageManager(body: string | ((record: string) => string) = ''): Fake {
    const dir = realpathSync(tempDir('marmeon-pm-bin-'));
    const record = join(dir, 'record.json');
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const fds = Object.fromEntries([0, 1, 2].map((fd) => [fd, (({ dev, ino }) => ({ dev, ino }))(fs.fstatSync(fd))]));",
      `fs.writeFileSync(${JSON.stringify(`${record}.tmp`)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid, fds }));`,
      `fs.renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});`,
      'setTimeout(() => process.exit(0), 20000).unref();',
      typeof body === 'function' ? body(record) : body,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'pnpm'), script);
    chmodSync(join(dir, 'pnpm'), 0o755);
    const fake = { bin: dir, record, cwd: realpathSync(tempDir('marmeon-pm-cwd-')) };
    vi.stubEnv('PATH', dir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      const seen = recorded(fake);
      killQuietly(seen?.pid);
      killQuietly(seen?.grandchild);
    });
    return fake;
  }

  /** Stand-in code that starts a grandchild (same process group unless `detached`) and records its pid. */
  const withGrandchild = (detached: boolean, lifetime = 20000) => (record: string) =>
    [
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${lifetime})'], { stdio: ['ignore', 'inherit', 'inherit'], detached: ${detached} });`,
      'grandchild.unref();',
      `const seen = JSON.parse(fs.readFileSync(${JSON.stringify(record)}, 'utf8'));`,
      `fs.writeFileSync(${JSON.stringify(`${record}.tmp`)}, JSON.stringify({ ...seen, grandchild: grandchild.pid }));`,
      `fs.renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});`,
    ].join('\n');

  const run = (fake: Fake, args: string[] = [], options: Partial<Parameters<PackageManagerProcess['run']>[2]> = {}) =>
    new PackageManagerProcess().run('pnpm', args, { cwd: fake.cwd, interactive: false, stdout: 'capture', ...options });

  it('passes a shell expansion on as one literal argument, runs no shell and drops NODE_ENV and MARMEON_*', async () => {
    const fake = fakePackageManager();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MARMEON_NODE_ENV_FROM_DOTENV', 'production');
    vi.stubEnv('MARMEON_APP_KEY', 'secret');
    vi.stubEnv('KEEP_ME', 'yes');
    const injected = '$(touch pwned)';
    const result = await run(fake, ['add', injected, '; touch pwned', '`touch pwned`']);
    expect(result.code).toBe(0);
    const seen = recorded(fake)!;
    expect(seen.argv).toEqual(['add', injected, '; touch pwned', '`touch pwned`']);
    expect(existsSync(join(fake.cwd, 'pwned'))).toBe(false);
    expect(readdirSync(fake.cwd)).toEqual([]);
    expect(seen.cwd).toBe(fake.cwd);
    expect(seen.env.NODE_ENV).toBeUndefined();
    expect(seen.env.MARMEON_NODE_ENV_FROM_DOTENV).toBeUndefined();
    expect(seen.env.MARMEON_APP_KEY).toBeUndefined();
    expect(seen.env.KEEP_ME).toBe('yes');
  });

  it('hands the package manager an explicit group, whatever save-dev the environment asks for', async () => {
    const fake = fakePackageManager();
    vi.stubEnv('npm_config_save_dev', 'true');
    const [args] = installArgs('pnpm', [{ name: 'marmeon', version: version('1.2.0'), group: 'dependencies' }]);
    await run(fake, args);
    const seen = recorded(fake)!;
    expect(seen.env.npm_config_save_dev).toBe('true');
    expect(seen.argv).toEqual(['add', '--save-exact', '--save-prod', 'marmeon@1.2.0']);
  });

  it('returns the exit code and captured output', async () => {
    const fake = fakePackageManager("process.stdout.write('hello'); process.exit(3);");
    await expect(run(fake)).resolves.toEqual({ code: 3, stdout: 'hello' });
  });

  it('refuses output beyond the cap and stops the child with SIGTERM, not only with the later SIGKILL', { timeout: 8_000 }, async () => {
    const fake = fakePackageManager("process.stdout.write('x'.repeat(5 << 20)); setInterval(() => {}, 1000);");
    await expect(run(fake, [], { graceMs: 60_000 })).rejects.toThrow('more than 4 MiB');
    expect(await gone(recorded(fake)!.pid)).toBe(true);
  });

  it('ends a run after its timeout, kills a child that ignores SIGTERM, and takes its group along', async () => {
    const grandchild = withGrandchild(false);
    const fake = fakePackageManager((record) => `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n${grandchild(record)}`);
    await expect(run(fake, [], { timeoutMs: 3000, graceMs: 200 })).rejects.toThrow('did not finish');
    const seen = recorded(fake)!;
    expect(await gone(seen.pid)).toBe(true);
    expect(await gone(seen.grandchild!)).toBe(true);
  });

  it('takes the group of a child along when the cap ends it', async () => {
    const grandchild = withGrandchild(false);
    const fake = fakePackageManager((record) => `${grandchild(record)}\nprocess.stdout.write('x'.repeat(5 << 20)); setInterval(() => {}, 1000);`);
    await expect(run(fake, [], { graceMs: 200 })).rejects.toThrow('more than 4 MiB');
    expect(await gone(recorded(fake)!.grandchild!)).toBe(true);
  });

  it('gives the result when a process that left the group keeps the pipe open', { timeout: 8_000 }, async () => {
    // The grandchild lives for 20 s, longer than this test may take: only the drain timer can end the wait.
    const fake = fakePackageManager((record) => `${withGrandchild(true)(record)}\nprocess.exit(0);`);
    await expect(run(fake, [], { drainMs: 100 })).resolves.toMatchObject({ code: 0 });
    expect(recorded(fake)!.grandchild).toBeTypeOf('number');
  });

  describe('the group of a run that exits', () => {
    /** The signals sent to a process group (a negative pid) by `run`, as `[signal, group]` in order; the polls (signal 0) are counted apart. */
    function spyOnGroupSignals() {
      const sent: { signal: string | number | undefined; group: number }[] = [];
      const original = process.kill.bind(process);
      const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid < 0) sent.push({ signal, group: -pid });
        return original(pid, signal);
      }) as typeof process.kill);
      onTestFinished(() => spy.mockRestore());
      return sent;
    }

    /** A stand-in that leaves a grandchild (no stdio) behind and exits 0, once the grandchild says it is set up (its SIGTERM handler is in). */
    const leaving = (ignoreSigterm: boolean) => (record: string) => {
      const ready = `${record}.ready`;
      const grandchildCode = `${ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''} require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, 20000)`;
      return [
        "const { spawn } = require('node:child_process');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });`,
        'grandchild.unref();',
        `const seen = JSON.parse(fs.readFileSync(${JSON.stringify(record)}, 'utf8'));`,
        `fs.writeFileSync(${JSON.stringify(`${record}.tmp`)}, JSON.stringify({ ...seen, grandchild: grandchild.pid }));`,
        `fs.renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});`,
        `for (let attempt = 0; attempt < 5_000_000 && !fs.existsSync(${JSON.stringify(ready)}); attempt++);`,
        'process.exit(0);',
      ].join('\n');
    };

    it('is ended with SIGTERM first and SIGKILL when it ignores that, before the run settles', async () => {
      const fake = fakePackageManager(leaving(true));
      const sent = spyOnGroupSignals();
      await expect(run(fake, [], { graceMs: 300 })).resolves.toMatchObject({ code: 0 });
      const pids = recorded(fake)!;
      // SIGKILL was sent before the run settled; the kernel may take a moment to reap the process.
      expect(await gone(pids.grandchild!)).toBe(true);
      const real = sent.filter((entry) => entry.signal !== 0 && entry.signal !== undefined);
      expect(real.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(new Set(real.map((entry) => entry.group))).toEqual(new Set([pids.pid]));
    });

    it('gets one SIGTERM and no SIGKILL when nothing is left, and nothing is sent to the group after the run settled', async () => {
      const fake = fakePackageManager('process.exit(0);');
      const sent = spyOnGroupSignals();
      await run(fake, [], { graceMs: 300 });
      const settled = sent.length;
      expect(sent.map((entry) => entry.signal)).toEqual(['SIGTERM']);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sent).toHaveLength(settled);
    });

    it('is polled until it is gone and then left alone: no SIGKILL, no signal after it ended', async () => {
      const fake = fakePackageManager(leaving(false));
      const sent = spyOnGroupSignals();
      await run(fake, [], { graceMs: 2_000 });
      expect(await gone(recorded(fake)!.grandchild!)).toBe(true);
      const settled = sent.length;
      expect(sent.filter((entry) => entry.signal === 'SIGKILL')).toEqual([]);
      expect(sent.filter((entry) => entry.signal === 'SIGTERM')).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sent).toHaveLength(settled);
    });
  });

  it('reports a child ended by a signal as code 1', async () => {
    const fake = fakePackageManager("process.kill(process.pid, 'SIGKILL');");
    await expect(run(fake)).resolves.toMatchObject({ code: 1 });
  });

  it('rejects when the package manager cannot be started', async () => {
    vi.stubEnv('PATH', realpathSync(tempDir('marmeon-pm-empty-')));
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    await expect(new PackageManagerProcess().run('pnpm', [], { cwd: realpathSync(tempDir('marmeon-pm-cwd-')), interactive: false, stdout: 'capture' })).rejects.toThrow('ENOENT');
  });

  it('stops the child and rejects when the signal aborts, and does not start after it aborted', async () => {
    const fake = fakePackageManager('setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const running = run(fake, [], { signal: controller.signal, graceMs: 200, stdout: 'inherit' });
    expect(await until(() => recorded(fake) !== undefined)).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(await gone(recorded(fake)!.pid)).toBe(true);
    await expect(run(fake, [], { signal: controller.signal })).rejects.toThrow('not started');
  });

  it('gives the child the CLI\'s own stderr as its stdout for stdout: stderr', async () => {
    const fake = fakePackageManager();
    const dir = realpathSync(tempDir('marmeon-pm-out-'));
    const [out, err] = [openSync(join(dir, 'out'), 'w'), openSync(join(dir, 'err'), 'w')];
    try {
      // A helper with its own files for descriptors 1 and 2, so that the two are told apart.
      const helper = `import { PackageManagerProcess } from ${JSON.stringify(PACKAGE_MANAGER)};\nawait new PackageManagerProcess().run('pnpm', [], { cwd: ${JSON.stringify(fake.cwd)}, interactive: false, stdout: 'stderr' });`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', helper], { stdio: ['ignore', out, err], env: process.env });
      expect(result.status).toBe(0);
    } finally {
      closeSync(out);
      closeSync(err);
    }
    const { dev, ino } = statSync(join(dir, 'err'));
    expect(recorded(fake)!.fds[1]).toEqual({ dev, ino });
  });

  it('closes stdin of a run that is not interactive', async () => {
    const fake = fakePackageManager();
    await run(fake);
    const devNull = statSync('/dev/null');
    expect(recorded(fake)!.fds[0]).toEqual({ dev: devNull.dev, ino: devNull.ino });
  });

  it('passes the terminal on to an interactive run', async (context) => {
    const own = fstatSync(0);
    const devNull = statSync('/dev/null');
    if (own.dev === devNull.dev && own.ino === devNull.ino) context.skip('stdin of the test process is /dev/null, so an inherited stdin cannot be told from a closed one');
    const fake = fakePackageManager();
    await run(fake, [], { interactive: true, stdout: 'inherit' });
    expect(recorded(fake)!.fds[0]).toEqual({ dev: own.dev, ino: own.ino });
  });

  it('adds no listener for a signal that stays after a run settles, whether it ends or is rejected', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const counts = () => signals.map((signal) => process.listenerCount(signal));
    const before = counts();
    const fake = fakePackageManager();
    await run(fake);
    expect(counts()).toEqual(before);
    const failing = fakePackageManager('process.exit(0);');
    const controller = new AbortController();
    const running = run(failing, [], { signal: controller.signal, graceMs: 200 });
    // The handlers are in place while the run is going.
    expect(counts()).toEqual(before.map((count) => count + 1));
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(counts()).toEqual(before);
  });

  it('sets a timeout only for a captured run unless the caller asks for one', async () => {
    const fake = fakePackageManager();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // A settled run leaves its group-ending timer behind (unref'd), so each step counts against the timers there already are.
    let base = vi.getTimerCount();
    const inherited = run(fake, [], { stdout: 'inherit' });
    expect(vi.getTimerCount() - base).toBe(0);
    await inherited;
    base = vi.getTimerCount();
    const asked = run(fake, [], { stdout: 'inherit', timeoutMs: 1000 });
    expect(vi.getTimerCount() - base).toBe(1);
    await asked;
    base = vi.getTimerCount();
    const captured = run(fake, []);
    expect(vi.getTimerCount() - base).toBe(1);
    await captured;
  });

  describe('a CLI that receives SIGINT in its process group', () => {
    it('passes it on, so the package manager of a run in a group of its own stops too', async () => {
      const fake = fakePackageManager('setInterval(() => {}, 1000);');
      const ready = join(fake.bin, 'ready');
      // The ready file is written after `run` has returned its promise, which is when its signal handlers are in place.
      const helper = [
        "import { writeFileSync } from 'node:fs';",
        `import { PackageManagerProcess } from ${JSON.stringify(PACKAGE_MANAGER)};`,
        `const running = new PackageManagerProcess().run('pnpm', [], { cwd: ${JSON.stringify(fake.cwd)}, interactive: false, stdout: 'inherit', graceMs: 200 });`,
        `writeFileSync(${JSON.stringify(ready)}, '');`,
        "try { await running; } catch (error) { console.log(error.message); process.exit(5); }",
      ].join('\n');
      const cli = spawn(process.execPath, ['--input-type=module', '-e', helper], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
      onTestFinished(() => killQuietly(cli.pid));
      let output = '';
      cli.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => cli.once('close', resolve));
      expect(await until(() => existsSync(ready) && recorded(fake) !== undefined)).toBe(true);
      process.kill(-cli.pid!, 'SIGINT');
      expect(await exited).toBe(5);
      expect(output).toContain('SIGINT');
      expect(await gone(recorded(fake)!.pid)).toBe(true);
    });
  });
});
