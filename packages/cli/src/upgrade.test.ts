import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CommandArgumentsError } from '@marmeon/core';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import type { CommandInput } from './command.ts';
import { UpgradeCommand } from './commands/upgrade.ts';
import { PackageManagerProcess, snapshotInstallFiles, type PackageManagerRun } from './framework/package-manager.ts';
import { Output } from './output.ts';
import { InstalledMarmeon } from './spawn.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const GUIDE_120 = '# Upgrading\n\n## Upgrading to 1.2.0 from 1.1.0\n\n### Sessions\n\n#### Medium: Renamed thing\n\nText.\n\n#### Low: Small thing\n\nText.\n';
const GUIDE_200 = '# Upgrading\n\n## Upgrading to 2.0.0 from 1.9.0\n\n#### High: Everything moved\n\nText.\n\n## Upgrading to 1.9.0 from 1.8.0\n\n#### Low: Older\n';
const LOCK = 'lockfileVersion: 9\n# old\n';

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const GROUP: Record<string, 'dependencies' | 'devDependencies'> = { marmeon: 'devDependencies', '@marmeon/core': 'dependencies', '@marmeon/database': 'dependencies' };

interface AppOptions {
  /** Version installed per package; a package left out is not listed. */
  readonly versions?: Record<string, string>;
  readonly manifest?: Record<string, unknown>;
  readonly lockfile?: string;
  readonly guide?: string;
  /** Where the app lives; a fresh temporary directory by default. */
  readonly at?: string;
}

/** An app with the three framework packages listed (exact) and installed, and a lockfile. */
function app({ versions = { '@marmeon/core': '1.1.0', '@marmeon/database': '1.1.0', marmeon: '1.1.0' }, manifest = {}, lockfile = 'pnpm-lock.yaml', guide = '# Upgrading\n', at }: AppOptions = {}): string {
  const root = at ?? realpathSync(tempDir('marmeon-upgrade-'));
  const lists: Record<string, Record<string, string>> = { dependencies: {}, devDependencies: {} };
  for (const [name, version] of Object.entries(versions)) {
    lists[GROUP[name]!]![name] = version;
    write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  write(join(root, 'node_modules/marmeon/UPGRADING.md'), guide);
  write(join(root, 'package.json'), JSON.stringify({ name: 'app', ...lists, ...manifest }, null, 2));
  write(join(root, lockfile), LOCK);
  return root;
}

/** A second copy of @marmeon/core below the installed marmeon, which the check of the versions refuses. */
function secondCore(root: string): void {
  const file = join(root, 'node_modules/marmeon/package.json');
  write(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), dependencies: { '@marmeon/core': '1.1.0' } }));
  write(join(root, 'node_modules/marmeon/node_modules/@marmeon/core/package.json'), JSON.stringify({ name: '@marmeon/core', version: '1.0.0' }));
}

const registry = (latest: string, versions: readonly string[]): string => JSON.stringify({ 'dist-tags': { latest }, versions });

interface Call {
  readonly name: string;
  readonly args: readonly string[];
  readonly options: PackageManagerRun;
}

interface Behaviour {
  readonly root: string;
  /** The `latest` tag the registry serves. */
  readonly latest?: string;
  /** What an install leaves in `node_modules` instead of the version it was asked for. */
  readonly installs?: string;
  readonly guide?: string | null;
  /** The exit code of the install of this call number (0-based among the installs). */
  readonly failInstall?: { readonly call: number; readonly code: number };
  /** Runs when an install starts, instead of finishing: it settles when the promise does. */
  readonly during?: (call: Call) => Promise<void>;
}

/** Stands in for pnpm: `view` answers from `latest`, an install rewrites the manifests, the lockfile and the guide, as pnpm would. */
class FakePackageManager extends PackageManagerProcess {
  readonly calls: Call[] = [];
  readonly #behaviour: Behaviour;
  #installs = 0;

  constructor(behaviour: Behaviour) {
    super();
    this.#behaviour = behaviour;
  }

  get installs(): Call[] {
    return this.calls.filter((call) => call.args[0] !== 'view');
  }

  override async run(name: 'pnpm' | 'npm', args: readonly string[], options: PackageManagerRun): Promise<{ code: number; stdout: string }> {
    const call = { name, args, options };
    this.calls.push(call);
    const { root, latest = '1.2.0', installs, guide, failInstall, during } = this.#behaviour;
    if (args[0] === 'view') return { code: 0, stdout: registry(latest, ['1.1.0', '1.2.0', '1.9.0', '2.0.0']) };
    const number = this.#installs++;
    const manifestFile = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, Record<string, string>>;
    for (const target of args.filter((arg) => /^(?:marmeon|@marmeon\/[a-z]+)@/.test(arg))) {
      const at = target.lastIndexOf('@');
      const [packageName, version] = [target.slice(0, at), installs ?? target.slice(at + 1)];
      manifest[GROUP[packageName]!]![packageName] = target.slice(at + 1);
      const installedFile = join(root, 'node_modules', packageName, 'package.json');
      write(installedFile, JSON.stringify({ ...JSON.parse(readFileSync(installedFile, 'utf8')), name: packageName, version }));
    }
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, name === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'), 'lockfileVersion: 9\n# new\n');
    if (guide !== null) write(join(root, 'node_modules/marmeon/UPGRADING.md'), guide ?? GUIDE_120);
    if (during) await during(call);
    if (failInstall?.call === number) return { code: failInstall.code, stdout: '' };
    return { code: 0, stdout: '' };
  }
}

class FakeMarmeon extends InstalledMarmeon {
  readonly calls: { root: string; args: readonly string[]; stdout: string; signal: AbortSignal | undefined }[] = [];
  readonly #codes: Record<string, number>;

  constructor(codes: Record<string, number> = {}) {
    super();
    this.#codes = codes;
  }

  override run(root: string, args: readonly string[], { stdout, signal }: { readonly stdout: 'inherit' | 'stderr'; readonly signal?: AbortSignal }): Promise<number> {
    this.calls.push({ root, args, stdout, signal });
    return Promise.resolve(this.#codes[args[0]!] ?? 0);
  }
}

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the command as `marmeon upgrade <flags>` in `root`; `terminal` answers a question with the index it holds. */
async function execute(root: string, packageManager: PackageManagerProcess, marmeon: InstalledMarmeon, options: CommandInput['options'] = {}, terminal?: { readonly answer: number }, writeFails?: string): Promise<Result & { readonly asked: string[] }> {
  const [out, err, asked]: [string[], string[], string[]] = [[], [], []];
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
    err.push(text);
    return true;
  }) as typeof process.stderr.write);
  const prompt = {
    interactive: terminal !== undefined,
    choose: (question: string) => {
      asked.push(question);
      return Promise.resolve(terminal ? [terminal.answer] : []);
    },
  };
  const code = await new UpgradeCommand(packageManager, marmeon).handle({ args: [], options, output: new Output((text) => {
      if (writeFails !== undefined && text.includes(writeFails)) throw new Error('stdout was closed');
      out.push(text);
    }), root, spawn: () => Promise.resolve(0), prompt } as CommandInput);
  return { code: code as number, stdout: out.join(''), stderr: err.join(''), asked };
}

const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');
const listed = (root: string): Record<string, string> => {
  const manifest = JSON.parse(read(root, 'package.json')) as Record<string, Record<string, string>>;
  return { ...manifest.dependencies, ...manifest.devDependencies };
};

describe('marmeon upgrade', { timeout: 30_000 }, () => {
  it('moves every group to the latest version, regenerates the types and shows the guide entries of the jump', async () => {
    const root = app();
    const pm = new FakePackageManager({ root });
    const marmeon = new FakeMarmeon();
    const { code, stdout } = await execute(root, pm, marmeon);
    expect(code).toBe(0);
    expect(pm.installs.map((call) => [call.name, ...call.args])).toEqual([
      ['pnpm', 'add', '--save-exact', '--save-prod', '@marmeon/core@1.2.0', '@marmeon/database@1.2.0'],
      ['pnpm', 'add', '--save-exact', '--save-dev', 'marmeon@1.2.0'],
    ]);
    expect(pm.installs.every((call) => call.options.cwd === root && !call.options.interactive && call.options.stdout === 'inherit' && call.options.signal !== undefined)).toBe(true);
    expect(pm.installs.every((call) => call.options.timeoutMs === undefined)).toBe(true);
    expect(listed(root)).toEqual({ '@marmeon/core': '1.2.0', '@marmeon/database': '1.2.0', marmeon: '1.2.0' });
    expect(marmeon.calls.map((call) => [call.root, ...call.args, call.stdout])).toEqual([
      [root, 'route:types', 'inherit'],
      [root, 'db:types', 'inherit'],
    ]);
    expect(stdout).toContain('Upgrading to 1.2.0 from 1.1.0');
    expect(stdout).toContain('Medium: Renamed thing');
    expect(stdout).toContain('Low: Small thing');
    expect(stdout).toContain('Read them: marmeon docs upgrading');
    expect(stdout).toContain('marmeon migrate');
    expect(stdout).toContain('marmeon doctor');
  });

  it('runs no db:types when the app has no database package', async () => {
    const root = app({ versions: { '@marmeon/core': '1.1.0', marmeon: '1.1.0' } });
    const marmeon = new FakeMarmeon();
    expect((await execute(root, new FakePackageManager({ root }), marmeon)).code).toBe(0);
    expect(marmeon.calls.map((call) => call.args[0])).toEqual(['route:types']);
  });

  it('says so when the guide has no entry between the versions', async () => {
    const root = app();
    const { code, stdout } = await execute(root, new FakePackageManager({ root, guide: '# Upgrading\n\n## Upgrading to 1.0.0 from 0.4.0\n\n#### Low: Old\n' }), new FakeMarmeon());
    expect(code).toBe(0);
    expect(stdout).toContain('The upgrade guide has no entry between 1.1.0 and 1.2.0.');
  });

  it('asks the person at the terminal once, with the plan, and installs on yes', async () => {
    const root = app();
    const pm = new FakePackageManager({ root });
    const result = await execute(root, pm, new FakeMarmeon(), {}, { answer: 0 });
    expect(result.code).toBe(0);
    expect(result.asked).toHaveLength(1);
    expect(result.stdout).toContain('@marmeon/core  1.1.0 -> 1.2.0');
    // A person is at the terminal: pnpm may ask its own question.
    expect(pm.installs.every((call) => call.options.interactive)).toBe(true);
  });

  it('changes nothing when the person at the terminal cancels', async () => {
    const root = app();
    const pm = new FakePackageManager({ root });
    const before = read(root, 'package.json');
    const { code } = await execute(root, pm, new FakeMarmeon(), {}, { answer: 1 });
    expect(code).toBe(1);
    expect(pm.installs).toEqual([]);
    expect(read(root, 'package.json')).toBe(before);
  });

  it('with --dry-run makes no install call, changes no file and prints the plan', async () => {
    const root = app();
    const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
    const pm = new FakePackageManager({ root });
    const marmeon = new FakeMarmeon();
    const { code, stdout } = await execute(root, pm, marmeon, { 'dry-run': true });
    expect(code).toBe(0);
    expect(pm.installs).toEqual([]);
    expect(marmeon.calls).toEqual([]);
    expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
    expect(stdout).toContain('pnpm add --save-exact --save-prod @marmeon/core@1.2.0 @marmeon/database@1.2.0');
    expect(stdout).toContain('Dry run');
  });

  it('prints, with --dry-run --json, a plan with no guide and no generated list', async () => {
    const root = app();
    const { code, stdout } = await execute(root, new FakePackageManager({ root }), new FakeMarmeon(), { 'dry-run': true, json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ format: 1, dryRun: true, guide: null, generated: null, from: '1.1.0', to: '1.2.0' });
  });

  it('prints one document that matches the stored format with --json, and keeps the package managers output off stdout', async () => {
    const root = app({ guide: GUIDE_120 });
    const pm = new FakePackageManager({ root });
    const marmeon = new FakeMarmeon();
    const { code, stdout } = await execute(root, pm, marmeon, { json: true });
    expect(code).toBe(0);
    const document = JSON.parse(stdout);
    const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-upgrade/v1.json', import.meta.url), 'utf8'));
    expect(document).toEqual(fixture);
    expect(Object.keys(document)).toEqual(Object.keys(fixture));
    expect(pm.installs.every((call) => call.options.stdout === 'stderr' && !call.options.interactive)).toBe(true);
    expect(marmeon.calls.every((call) => call.stdout === 'stderr')).toBe(true);
  });

  it('prints breaking: true for a dry run of an exact --to across a major, and an unreadable guide as null with one warning and an empty stderr', async () => {
    const root = app({ versions: { '@marmeon/core': '1.9.0', marmeon: '1.9.0' } });
    const dry = await execute(root, new FakePackageManager({ root }), new FakeMarmeon(), { to: '2.0.0', 'dry-run': true, json: true });
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, breaking: true, from: '1.9.0', to: '2.0.0' });
    const unreadable = app();
    unlinkSync(join(unreadable, 'node_modules/marmeon/UPGRADING.md'));
    const run = await execute(unreadable, new FakePackageManager({ root: unreadable, guide: null }), new FakeMarmeon(), { json: true });
    const document = JSON.parse(run.stdout);
    expect(run.code).toBe(0);
    expect(document.guide).toBeNull();
    expect(document.warnings).toHaveLength(1);
    expect(run.stderr).toBe('');
    expect(document.generated).toEqual([{ command: 'route:types', exitCode: 0 }, { command: 'db:types', exitCode: 0 }]);
  });

  it('never asks with --json, even at a terminal, and refuses a breaking move that is not explicit', async () => {
    const root = app({ versions: { '@marmeon/core': '1.9.0', marmeon: '1.9.0' } });
    const pm = new FakePackageManager({ root, latest: '2.0.0' });
    const result = await execute(root, pm, new FakeMarmeon(), { json: true }, { answer: 0 });
    expect(result.code).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.stdout).toBe('');
    expect(pm.installs).toEqual([]);
  });

  describe('a breaking move', () => {
    const breaking = () => app({ versions: { '@marmeon/core': '1.9.0', marmeon: '1.9.0' }, guide: GUIDE_200 });

    it('without a terminal and without --to refuses, names --to=<version> and installs nothing', async () => {
      const root = breaking();
      const pm = new FakePackageManager({ root, latest: '2.0.0' });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(1);
      expect(stderr).toContain('--to=2.0.0');
      expect(pm.installs).toEqual([]);
    });

    it('does not take a tag for a confirmation either', async () => {
      const root = breaking();
      const pm = new FakePackageManager({ root, latest: '2.0.0' });
      expect((await execute(root, pm, new FakeMarmeon(), { to: 'latest' })).code).toBe(1);
      expect(pm.installs).toEqual([]);
    });

    it('proceeds with --to=2.0.0 and shows the guide', async () => {
      const root = breaking();
      const pm = new FakePackageManager({ root, guide: GUIDE_200 });
      const { code, stdout } = await execute(root, pm, new FakeMarmeon(), { to: '2.0.0' });
      expect(code).toBe(0);
      expect(pm.installs.length).toBeGreaterThan(0);
      expect(stdout).toContain('Upgrading to 2.0.0 from 1.9.0');
      expect(stdout).toContain('High: Everything moved');
    });

    it('asks at a terminal with both versions and the guide section, and installs only on yes', async () => {
      const root = breaking();
      const pm = new FakePackageManager({ root, latest: '2.0.0', guide: GUIDE_200 });
      const no = await execute(root, pm, new FakeMarmeon(), {}, { answer: 1 });
      expect(no.code).toBe(1);
      expect(no.asked).toEqual([expect.stringContaining('1.9.0 to 2.0.0')]);
      expect(no.asked[0]).toContain('Upgrading to 2.0.0 from');
      expect(pm.installs).toEqual([]);
      expect((await execute(root, pm, new FakeMarmeon(), {}, { answer: 0 })).code).toBe(0);
    });

    it('is a dry run without a terminal when --dry-run is given', async () => {
      const root = breaking();
      const pm = new FakePackageManager({ root, latest: '2.0.0' });
      const { code, stdout } = await execute(root, pm, new FakeMarmeon(), { 'dry-run': true });
      expect(code).toBe(0);
      expect(stdout).toContain('a breaking move');
      expect(pm.installs).toEqual([]);
    });

    it('warns instead of printing "no entries" when the guide of a breaking move cannot be read', async () => {
      const root = breaking();
      const { code, stdout, stderr } = await execute(root, new FakePackageManager({ root, guide: '# Upgrading\n' }), new FakeMarmeon(), { to: '2.0.0' });
      expect(code).toBe(0);
      expect(stderr).toContain('has no section for 1.9.0 to 2.0.0');
      expect(stderr).toContain('marmeon docs upgrading');
      expect(stdout).not.toContain('no entry');
    });
  });

  it('refuses a downgrade and installs nothing', async () => {
    const root = app();
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.0.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('does not downgrade');
    expect(pm.installs).toEqual([]);
  });

  it('refuses an exact --to below the highest package of a mix, names the versions, and installs nothing', async () => {
    const root = app({ versions: { '@marmeon/core': '1.2.0', marmeon: '1.1.0' } });
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.1.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('below an installed version (1.2.0, 1.1.0)');
    expect(stderr).toContain('does not downgrade');
    expect(pm.calls).toEqual([]);
  });

  it('says it is already there, installs nothing and prints a document with --json', async () => {
    const root = app();
    const pm = new FakePackageManager({ root, latest: '1.1.0' });
    const plain = await execute(root, pm, new FakeMarmeon());
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('already at 1.1.0');
    const json = await execute(root, pm, new FakeMarmeon(), { json: true });
    expect(JSON.parse(json.stdout)).toMatchObject({ format: 1, commands: [], to: '1.1.0' });
    expect(pm.installs).toEqual([]);
  });

  describe('a mixed install', () => {
    const mixed = () => app({ versions: { '@marmeon/core': '1.1.0', marmeon: '1.0.0' } });

    it('is refused without --to', async () => {
      const root = mixed();
      const pm = new FakePackageManager({ root });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(1);
      expect(stderr).toContain('--to=<exact version>');
      expect(pm.installs).toEqual([]);
    });

    it.each(['latest', 'next'])('is not repaired by a tag: --to=%s is refused and nothing is installed', async (to) => {
      const root = mixed();
      const pm = new FakePackageManager({ root, latest: '1.1.0' });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to });
      expect(code).toBe(1);
      expect(stderr).toContain('--to=<exact version>');
      expect(pm.installs).toEqual([]);
    });

    it('never answers "already there" for a second copy below node_modules/marmeon: it installs, and the check after it judges', async () => {
      const root = app();
      secondCore(root);
      const pm = new FakePackageManager({ root });
      const { code, stdout, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.1.0' });
      expect(pm.installs.length).toBeGreaterThan(0);
      expect(stdout).not.toContain('already at');
      // The fake leaves the second copy where it is, so the check after the install refuses.
      expect(code).toBe(1);
      expect(stderr).toContain('not in one version');
    });

    it('is repaired with --to=1.1.0', async () => {
      const root = mixed();
      const pm = new FakePackageManager({ root });
      const { code } = await execute(root, pm, new FakeMarmeon(), { to: '1.1.0' });
      expect(code).toBe(0);
      expect(listed(root)).toEqual({ '@marmeon/core': '1.1.0', marmeon: '1.1.0' });
    });
  });

  it('moves when an exact spec in package.json is not the installed version, instead of answering "already there"', async () => {
    const root = app({ versions: { '@marmeon/core': '1.2.0', '@marmeon/database': '1.2.0', marmeon: '1.2.0' } });
    const manifest = JSON.parse(read(root, 'package.json')) as Record<string, Record<string, string>>;
    for (const group of ['dependencies', 'devDependencies']) for (const name of Object.keys(manifest[group]!)) manifest[group]![name] = '1.1.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const pm = new FakePackageManager({ root, latest: '1.2.0' });
    const { code, stdout } = await execute(root, pm, new FakeMarmeon());
    expect(code).toBe(0);
    expect(stdout).not.toContain('already at');
    expect(pm.installs.length).toBeGreaterThan(0);
    expect(listed(root)).toEqual({ '@marmeon/core': '1.2.0', '@marmeon/database': '1.2.0', marmeon: '1.2.0' });
  });

  it('refuses when package.json pins a package above the target, names it and installs nothing', async () => {
    const root = app({ versions: { '@marmeon/core': '1.2.0', marmeon: '1.2.0' } });
    const manifest = JSON.parse(read(root, 'package.json')) as Record<string, Record<string, string>>;
    manifest.dependencies!['@marmeon/core'] = '1.3.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const pm = new FakePackageManager({ root, latest: '1.2.0' });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon());
    expect(code).toBe(1);
    expect(stderr).toContain('pins @marmeon/core to 1.3.0, above 1.2.0');
    expect(stderr).toContain('pnpm install');
    expect(pm.installs).toEqual([]);
  });

  it('is already there for range specs when everything is at the target: a range is no out-of-line pin', async () => {
    const root = app({ versions: { '@marmeon/core': '1.2.0', marmeon: '1.2.0' } });
    const manifest = JSON.parse(read(root, 'package.json')) as Record<string, Record<string, string>>;
    for (const group of ['dependencies', 'devDependencies']) for (const name of Object.keys(manifest[group]!)) manifest[group]![name] = '^1.2.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const pm = new FakePackageManager({ root, latest: '1.2.0' });
    expect((await execute(root, pm, new FakeMarmeon())).stdout).toContain('already at 1.2.0');
    expect(pm.installs).toEqual([]);
  });

  it('is already there when every exact spec is the installed version', async () => {
    const root = app({ versions: { '@marmeon/core': '1.2.0', marmeon: '1.2.0' } });
    const pm = new FakePackageManager({ root, latest: '1.2.0' });
    expect((await execute(root, pm, new FakeMarmeon())).stdout).toContain('already at 1.2.0');
    expect(pm.installs).toEqual([]);
  });

  it('refuses an app that does not list marmeon, which runs the generators', async () => {
    const root = app({ versions: { '@marmeon/core': '1.1.0' } });
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('does not list marmeon');
    expect(pm.calls).toEqual([]);
  });

  it('refuses a registry latest that is not a version, and installs nothing', async () => {
    const root = app();
    const pm = new FakePackageManager({ root, latest: 'file:../x' });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon());
    expect(code).toBe(1);
    expect(stderr).toContain('Pass --to=<version>');
    expect(pm.calls.filter((call) => call.args[0] !== 'view')).toEqual([]);
  });

  it.each(['^1.2.0', '1.2', '--registry=https://evil.test', 'file:../x'])('exits with 2 for --to=%s', async (to) => {
    const root = app();
    const pm = new FakePackageManager({ root });
    await expect(execute(root, pm, new FakeMarmeon(), { to })).rejects.toThrow(CommandArgumentsError);
    expect(pm.calls).toEqual([]);
  });

  it('refuses a framework package listed with workspace:*, with the text of the refusal, and runs nothing', async () => {
    const root = app({ manifest: { dependencies: { '@marmeon/core': 'workspace:*' } } });
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('"workspace:*"');
    expect(pm.calls).toEqual([]);
  });

  it('refuses a package manager of another kind and prints the manual commands', async () => {
    const root = app({ lockfile: 'yarn.lock' });
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('yarn.lock belongs to a package manager Marmeon does not run');
    expect(stderr).toContain('yarn add -E @marmeon/core@1.2.0 @marmeon/database@1.2.0');
    expect(pm.calls).toEqual([]);
  });

  it('refuses an app that is the root of a workspace', async () => {
    const root = app({ manifest: { workspaces: ['packages/*'] } });
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('root of a workspace');
    expect(pm.calls).toEqual([]);
  });

  it('refuses a framework package that is listed only as a peer', async () => {
    const root = app({ manifest: { dependencies: { '@marmeon/core': '1.1.0' }, devDependencies: {}, peerDependencies: { '@marmeon/http': '1.1.0' } } });
    write(join(root, 'node_modules/@marmeon/http/package.json'), JSON.stringify({ name: '@marmeon/http', version: '1.1.0' }));
    const pm = new FakePackageManager({ root });
    const { code, stderr } = await execute(root, pm, new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    expect(stderr).toContain('peerDependencies');
    expect(pm.calls).toEqual([]);
  });

  describe('when the install fails', () => {
    it('leaves package.json and the lockfile byte for byte as they were, and says how to install again', async () => {
      const root = app();
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
      const pm = new FakePackageManager({ root, failInstall: { call: 1, code: 1 } });
      const marmeon = new FakeMarmeon();
      const { code, stderr } = await execute(root, pm, marmeon);
      // The first group was installed by then, so the files had changed.
      expect(pm.installs).toHaveLength(2);
      expect(code).toBe(1);
      expect(read(root, 'package.json')).toBe(manifest);
      expect(read(root, 'pnpm-lock.yaml')).toBe(lock);
      expect(stderr).toContain('run "pnpm install"');
      expect(stderr).toContain('ERR_PNPM_IGNORED_BUILDS');
      expect(marmeon.calls).toEqual([]);
    });

    it('does the same when the package manager cannot be started', async () => {
      const root = app();
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
      const pm = new FakePackageManager({ root, during: () => Promise.reject(new Error('spawn pnpm ENOENT')) });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(1);
      expect(stderr).toContain('ENOENT');
      expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
    });
  });

  describe('with npm', () => {
    it('installs each group with the argument lists of npm, which keep devDependencies and the group', async () => {
      const root = app({ lockfile: 'package-lock.json' });
      const pm = new FakePackageManager({ root });
      const { code } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(0);
      expect(pm.installs.map((call) => [call.name, ...call.args])).toEqual([
        ['npm', 'install', '--save-exact', '--save-prod', '--include=dev', '--no-fund', '@marmeon/core@1.2.0', '@marmeon/database@1.2.0'],
        ['npm', 'install', '--save-exact', '--save-dev', '--include=dev', '--no-fund', 'marmeon@1.2.0'],
      ]);
      expect(pm.calls[0]).toMatchObject({ name: 'npm', args: ['view', 'marmeon', 'dist-tags', 'versions', '--json'] });
    });

    it('puts package.json and package-lock.json back byte for byte when the install fails, and says npm install', async () => {
      const root = app({ lockfile: 'package-lock.json' });
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'package-lock.json')];
      const pm = new FakePackageManager({ root, failInstall: { call: 1, code: 1 } });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(1);
      expect([read(root, 'package.json'), read(root, 'package-lock.json')]).toEqual([manifest, lock]);
      expect(stderr).toContain('run "npm install"');
      expect(stderr).not.toContain('approve-builds');
    });
  });

  describe('pnpm-workspace.yaml', () => {
    it('is put back with the other files when the install fails, and a copy that pnpm made is removed', async () => {
      const root = app();
      write(join(root, 'pnpm-workspace.yaml'), 'saveExact: true\n');
      const during = (): Promise<void> => {
        writeFileSync(join(root, 'pnpm-workspace.yaml'), 'saveExact: true\nminimumReleaseAgeExclude:\n  - marmeon\n');
        return Promise.resolve();
      };
      const { code } = await execute(root, new FakePackageManager({ root, during, failInstall: { call: 0, code: 1 } }), new FakeMarmeon());
      expect(code).toBe(1);
      expect(read(root, 'pnpm-workspace.yaml')).toBe('saveExact: true\n');
    });

    it('removes a pnpm-workspace.yaml that did not exist before the failed install', async () => {
      const root = app();
      const during = (): Promise<void> => {
        writeFileSync(join(root, 'pnpm-workspace.yaml'), 'minimumReleaseAgeExclude:\n  - marmeon\n');
        return Promise.resolve();
      };
      await execute(root, new FakePackageManager({ root, during, failInstall: { call: 0, code: 1 } }), new FakeMarmeon());
      expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(false);
    });

    it.each(['../x', 'a/b', '..', '', 'a\\b'])('takes only a file name as an extra file of the snapshot: %j throws', (name) => {
      const root = app();
      expect(() => snapshotInstallFiles(root, 'pnpm-lock.yaml', [name])).toThrow('not a file name');
    });

    it('names pnpm-workspace.yaml in the message when it was part of the snapshot, and not when there was none', async () => {
      const root = app();
      write(join(root, 'pnpm-workspace.yaml'), 'saveExact: true\n');
      const failing = { failInstall: { call: 0, code: 1 } } as const;
      expect((await execute(root, new FakePackageManager({ root, ...failing }), new FakeMarmeon())).stderr).toContain('package.json, pnpm-lock.yaml, pnpm-workspace.yaml are back as they were');
      const plain = app();
      expect((await execute(plain, new FakePackageManager({ root: plain, ...failing }), new FakeMarmeon())).stderr).toContain('package.json, pnpm-lock.yaml are back as they were');
    });

    it('is taken by snapshotInstallFiles only as an extra file, and restore never deletes package.json or the lockfile', () => {
      const root = app();
      write(join(root, 'pnpm-workspace.yaml'), 'a: 1\n');
      const snapshot = snapshotInstallFiles(root, 'pnpm-lock.yaml');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'a: 2\n');
      snapshot.restore();
      expect(read(root, 'pnpm-workspace.yaml')).toBe('a: 2\n');
    });
  });

  describe('after the install passed its check', () => {
    it('puts the files back when the check finds a mixed state, and says it is not in one version', async () => {
      const root = app();
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
      const during = (): Promise<void> => {
        secondCore(root);
        return Promise.resolve();
      };
      const { code, stderr } = await execute(root, new FakePackageManager({ root, during }), new FakeMarmeon());
      expect(code).toBe(1);
      expect(stderr).toContain('not in one version');
      expect(stderr).toContain('run "pnpm install"');
      expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
    });

    it('decides db:types by the packages the app lists, not by a node_modules above it', async () => {
      const parent = realpathSync(tempDir('marmeon-upgrade-parent-'));
      write(join(parent, 'node_modules/@marmeon/database/package.json'), JSON.stringify({ name: '@marmeon/database', version: '1.2.0' }));
      const at = join(parent, 'app');
      mkdirSync(at);
      const root = app({ versions: { '@marmeon/core': '1.1.0', marmeon: '1.1.0' }, at });
      const marmeon = new FakeMarmeon();
      expect((await execute(root, new FakePackageManager({ root }), marmeon)).code).toBe(0);
      expect(marmeon.calls.map((call) => call.args[0])).toEqual(['route:types']);
    });

    it('runs db:types when the app lists @marmeon/database', async () => {
      const root = app();
      const marmeon = new FakeMarmeon();
      expect((await execute(root, new FakePackageManager({ root }), marmeon)).code).toBe(0);
      expect(marmeon.calls.map((call) => call.args[0])).toEqual(['route:types', 'db:types']);
    });

    it('keeps the files when something throws after the check passed, outside the generators', async () => {
      const root = app();
      const marmeon = new FakeMarmeon();
      const { code, stderr } = await execute(root, new FakePackageManager({ root }), marmeon, {}, undefined, 'Renamed thing');
      expect(code).toBe(1);
      expect(marmeon.calls).toEqual([]);
      expect(listed(root)['marmeon']).toBe('1.2.0');
      expect(stderr).toContain('The packages are at 1.2.0, and package.json and pnpm-lock.yaml keep it, but stdout was closed');
      expect(stderr).toContain('Run marmeon route:types');
    });

    it('keeps the files when a generator cannot start, and names the generator to run again', async () => {
      const root = app();
      class Broken extends FakeMarmeon {
        override run(): Promise<number> {
          return Promise.reject(new Error('the installed marmeon has no bin/marmeon.js'));
        }
      }
      const { code, stderr } = await execute(root, new FakePackageManager({ root }), new Broken());
      expect(code).toBe(1);
      expect(listed(root)).toEqual({ '@marmeon/core': '1.2.0', '@marmeon/database': '1.2.0', marmeon: '1.2.0' });
      expect(stderr).toContain('The packages are at 1.2.0');
      expect(stderr).toContain('could not run (the installed marmeon has no bin/marmeon.js)');
      expect(stderr).toContain('run marmeon route:types and marmeon db:types');
    });
  });

  describe('on a signal', () => {
    /** The fake pnpm that, like the real one, ends only after its group is gone, and writes once more while it ends. */
    const dying = (root: string, events: string[], name: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): Behaviour['during'] => (call) =>
      new Promise<void>((_, reject) => {
        const signal = call.options.signal!;
        const stop = () => {
          setTimeout(() => {
            // A process of the group still writing: a restore before the run settled would lose to it.
            writeFileSync(join(root, 'package.json'), '{"name":"half-written"}');
            events.push('settled');
            reject(new Error('pnpm was stopped: the run was aborted'));
          }, 30);
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
        events.push('running');
        setImmediate(() => process.emit(name));
      });

    it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('on %s stops the install, restores the files only after the run settled, and exits by itself', async (name) => {
      const root = app();
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
      const events: string[] = [];
      const marmeon = new FakeMarmeon();
      const before = process.listenerCount(name);
      const { code, stderr } = await execute(root, new FakePackageManager({ root, during: dying(root, events, name) }), marmeon);
      expect(code).toBe(1);
      expect(events).toEqual(['running', 'settled']);
      expect(read(root, 'package.json')).toBe(manifest);
      expect(read(root, 'pnpm-lock.yaml')).toBe(lock);
      expect(stderr).toContain(name);
      expect(stderr).toContain('run "pnpm install"');
      expect(marmeon.calls).toEqual([]);
      // The handlers are gone again.
      expect(process.listenerCount(name)).toBe(before);
    });

    it('stops between the two install groups when the signal came after the first one, and restores', async () => {
      const root = app();
      const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
      const during = (): Promise<void> => {
        process.emit('SIGINT');
        return Promise.resolve();
      };
      const pm = new FakePackageManager({ root, during });
      const { code, stderr } = await execute(root, pm, new FakeMarmeon());
      expect(code).toBe(1);
      expect(pm.installs).toHaveLength(1);
      expect(stderr).toContain('stopped by SIGINT');
      expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
    });

    it('keeps the files when a generator is stopped after the check passed, and names the generator to run again', async () => {
      const root = app();
      class StoppedMarmeon extends FakeMarmeon {
        override run(root: string, args: readonly string[], options: { readonly stdout: 'inherit' | 'stderr'; readonly signal?: AbortSignal }): Promise<number> {
          this.calls.push({ root, args, stdout: options.stdout, signal: options.signal });
          process.emit('SIGINT');
          return Promise.reject(new Error('marmeon was stopped: the run was aborted'));
        }
      }
      const marmeon = new StoppedMarmeon();
      const pm = new FakePackageManager({ root });
      const { code, stderr } = await execute(root, pm, marmeon);
      expect(code).toBe(1);
      expect(listed(root)).toEqual({ '@marmeon/core': '1.2.0', '@marmeon/database': '1.2.0', marmeon: '1.2.0' });
      expect(read(root, 'pnpm-lock.yaml')).toContain('# new');
      expect(stderr).toContain('marmeon route:types was stopped by SIGINT');
      expect(stderr).toContain('run marmeon route:types and marmeon db:types');
      // The loop does not start db:types once the signal came: that branch is what this proves.
      expect(marmeon.calls).toHaveLength(1);
      expect(marmeon.calls.every((call) => call.signal !== undefined)).toBe(true);
    });
  });

  it('fails when the install leaves another version than the one asked for', async () => {
    const root = app();
    const marmeon = new FakeMarmeon();
    const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
    const { code, stderr } = await execute(root, new FakePackageManager({ root, installs: '1.1.5' }), marmeon);
    expect(code).toBe(1);
    expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
    expect(stderr).toContain('run "pnpm install"');
    expect(stderr).toContain('1.1.5, not 1.2.0');
    expect(stderr).toContain('the-first-day-after-a-release');
    expect(marmeon.calls).toEqual([]);
  });

  it('fails with the generator command to run again when a generator exits with 1', async () => {
    const root = app();
    const marmeon = new FakeMarmeon({ 'route:types': 1 });
    const { code, stderr, stdout } = await execute(root, new FakePackageManager({ root }), marmeon);
    expect(code).toBe(1);
    expect(stderr).toContain('The packages are at 1.2.0');
    expect(stderr).toContain('marmeon route:types failed');
    expect(stdout).toContain('Medium: Renamed thing');
    // The other generator still ran.
    expect(marmeon.calls.map((call) => call.args[0])).toEqual(['route:types', 'db:types']);
    expect(listed(root)['@marmeon/core']).toBe('1.2.0');
  });

  it('prints the control characters of an entry title written out', async () => {
    const root = app();
    const guide = '# Upgrading\n\n## Upgrading to 1.2.0 from 1.1.0\n\n#### High: Evil \x1b[2J\x1b]0;owned\x07 title\n';
    const { code, stdout } = await execute(root, new FakePackageManager({ root, guide }), new FakeMarmeon());
    expect(code).toBe(0);
    for (const raw of ['\x1b', '\x07']) expect(stdout).not.toContain(raw);
    expect(stdout).toContain('\\u001b[2J');
  });

  it('warns and goes on with exit 0 when the guide is missing', async () => {
    const root = app();
    unlinkSync(join(root, 'node_modules/marmeon/UPGRADING.md'));
    const { code, stderr } = await execute(root, new FakePackageManager({ root, guide: null }), new FakeMarmeon());
    expect(code).toBe(0);
    expect(stderr).toContain('could not be read');
    expect(stderr).toContain('marmeon docs upgrading');
  });

  it('does not read a guide that is a link', async () => {
    const root = app();
    const outside = join(realpathSync(tempDir('marmeon-upgrade-outside-')), 'UPGRADING.md');
    writeFileSync(outside, GUIDE_120);
    const pm = new FakePackageManager({ root, guide: null });
    const marmeon = new FakeMarmeon();
    const link = join(root, 'node_modules/marmeon/UPGRADING.md');
    unlinkSync(link);
    symlinkSync(outside, link);
    const { code, stdout, stderr } = await execute(root, pm, marmeon);
    expect(code).toBe(0);
    expect(stdout).not.toContain('Renamed thing');
    expect(stderr).toContain('could not be read');
  });

  it('runs the package manager without NODE_ENV=production in its environment', async () => {
    const root = app();
    const bin = realpathSync(tempDir('marmeon-upgrade-bin-'));
    const record = join(bin, 'env.json');
    write(join(bin, 'pnpm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));\nprocess.exit(1);\n`);
    chmodSync(join(bin, 'pnpm'), 0o755);
    vi.stubEnv('PATH', bin);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MARMEON_NODE_ENV_FROM_DOTENV', 'production');
    const [manifest, lock] = [read(root, 'package.json'), read(root, 'pnpm-lock.yaml')];
    const { code } = await execute(root, new PackageManagerProcess(), new FakeMarmeon(), { to: '1.2.0' });
    expect(code).toBe(1);
    const env = JSON.parse(readFileSync(record, 'utf8')) as NodeJS.ProcessEnv;
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.MARMEON_NODE_ENV_FROM_DOTENV).toBeUndefined();
    // The failing install of the real process runs through the same restore.
    expect([read(root, 'package.json'), read(root, 'pnpm-lock.yaml')]).toEqual([manifest, lock]);
  });

  it('is a built-in command that does not boot the app and has the usage of the docs', () => {
    expect([UpgradeCommand.command, UpgradeCommand.boots, UpgradeCommand.usage]).toEqual(['upgrade', false, '[--to=<version|tag>] [--dry-run] [--json]']);
  });
});

describe('InstalledMarmeon', { timeout: 30_000 }, () => {
  /** An app whose installed `marmeon` has a launcher that writes its arguments, environment and directory to `<root>/seen.json`. */
  function installed(): { root: string; pkg: string } {
    const root = realpathSync(tempDir('marmeon-installed-'));
    const pkg = join(root, 'node_modules/marmeon');
    write(join(pkg, 'package.json'), JSON.stringify({ name: 'marmeon', version: '1.2.0' }));
    write(join(pkg, 'bin/marmeon.js'), `require('node:fs').writeFileSync('seen.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), version: '1.2.0' }));\n`);
    return { root, pkg };
  }

  const seen = (root: string) => JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8')) as { argv: string[]; env: NodeJS.ProcessEnv; cwd: string; version: string };

  it('runs the launcher of the installed package with the arguments, in the app, and asks nothing', async () => {
    const { root } = installed();
    vi.stubEnv('MARMEON_CHILD', '1');
    vi.stubEnv('MARMEON_LAUNCH', '1');
    expect(await new InstalledMarmeon().run(root, ['route:types'], { stdout: 'stderr' })).toBe(0);
    expect(seen(root)).toMatchObject({ argv: ['route:types'], cwd: root });
    expect(seen(root).env.MARMEON_NO_INTERACTION).toBe('1');
    expect(seen(root).env.MARMEON_CHILD).toBeUndefined();
    expect(seen(root).env.MARMEON_LAUNCH).toBeUndefined();
  });

  it('looks the launcher up at each call: a package replaced in between is the one that runs', async () => {
    const { root, pkg } = installed();
    const marmeon = new InstalledMarmeon();
    await marmeon.run(root, ['a'], { stdout: 'stderr' });
    expect(seen(root).version).toBe('1.2.0');
    write(join(pkg, 'bin/marmeon.js'), `require('node:fs').writeFileSync('seen.json', JSON.stringify({ version: '2.0.0' }));\n`);
    await marmeon.run(root, ['b'], { stdout: 'stderr' });
    expect(seen(root).version).toBe('2.0.0');
  });

  it('passes the exit code on', async () => {
    const { root, pkg } = installed();
    write(join(pkg, 'bin/marmeon.js'), 'process.exit(3);\n');
    expect(await new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).toBe(3);
  });

  it('refuses a bin/marmeon.js that is a link to a file outside the package, and runs nothing', async () => {
    const { root, pkg } = installed();
    const outside = join(realpathSync(tempDir('marmeon-installed-outside-')), 'evil.js');
    writeFileSync(outside, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'pwned'))}, 'x');\n`);
    unlinkSync(join(pkg, 'bin/marmeon.js'));
    symlinkSync(outside, join(pkg, 'bin/marmeon.js'));
    await expect(new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).rejects.toThrow('leads outside the package');
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it('refuses a bin directory that is a link to a directory outside the package', async () => {
    const { root, pkg } = installed();
    const outside = realpathSync(tempDir('marmeon-installed-outside-'));
    writeFileSync(join(outside, 'marmeon.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'pwned'))}, 'x');\n`);
    rmSync(join(pkg, 'bin'), { recursive: true });
    symlinkSync(outside, join(pkg, 'bin'), 'dir');
    await expect(new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).rejects.toThrow('leads outside the package');
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it('refuses a package.json that is a link to another directory, and runs nothing', async () => {
    const { root, pkg } = installed();
    const other = realpathSync(tempDir('marmeon-installed-other-'));
    write(join(other, 'package.json'), JSON.stringify({ name: 'marmeon', version: '9.9.9' }));
    unlinkSync(join(pkg, 'package.json'));
    symlinkSync(join(other, 'package.json'), join(pkg, 'package.json'));
    await expect(new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).rejects.toThrow('package.json of its own');
    expect(existsSync(join(root, 'seen.json'))).toBe(false);
  });

  it('follows a package that is itself a link, as pnpm lays it out, when the launcher lies inside the real directory', async () => {
    const root = realpathSync(tempDir('marmeon-installed-'));
    const real = join(root, '.store/marmeon');
    write(join(real, 'package.json'), JSON.stringify({ name: 'marmeon', version: '1.2.0' }));
    write(join(real, 'bin/marmeon.js'), `require('node:fs').writeFileSync('seen.json', '{}');\n`);
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(real, join(root, 'node_modules/marmeon'), 'dir');
    expect(await new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).toBe(0);
    expect(existsSync(join(root, 'seen.json'))).toBe(true);
  });

  it('refuses an app without an installed marmeon', async () => {
    const root = realpathSync(tempDir('marmeon-installed-'));
    await expect(new InstalledMarmeon().run(root, [], { stdout: 'stderr' })).rejects.toThrow('is not installed');
  });

  it('stops the child when the signal aborts, and rejects once it is gone', async () => {
    const { root, pkg } = installed();
    write(join(pkg, 'bin/marmeon.js'), `require('node:fs').writeFileSync('pid', String(process.pid));\nsetTimeout(() => {}, 20000);\n`);
    const controller = new AbortController();
    const running = new InstalledMarmeon().run(root, [], { stdout: 'stderr', signal: controller.signal });
    onTestFinished(() => {
      try {
        process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    for (let attempt = 0; attempt < 500 && !existsSync(join(root, 'pid')); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(root, 'pid'))).toBe(true);
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow();
  });
});
