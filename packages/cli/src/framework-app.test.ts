import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { packagesCheck, problemsAgainst } from './check/packages.ts';
import { readFrameworkState } from './framework/app-framework.ts';
import { readPnpmWorkspace } from './framework/pnpm-workspace.ts';
import { repo } from './__fixtures__/cli.js';

const reads = vi.hoisted(() => new Map<string, number>());
const limit = vi.hoisted(() => ({ on: false }));

// Counts what is read, so that a test can prove how much work the walk did.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      const count = (reads.get(String(path)) ?? 0) + 1;
      reads.set(String(path), count);
      // A plain error, which the readers rethrow: a loop that reads one file again and again ends here, fast.
      if (limit.on && count > 20) throw new Error('read too often');
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

/** An app listing `specs` (`name → spec`) with `installed` (`name → version`) in `node_modules`. */
function app(specs: Record<string, string>, installed: Record<string, string>, dev: readonly string[] = []): string {
  const root = realpathSync(tempDir('marmeon-framework-'));
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) (dev.includes(name) ? devDependencies : dependencies)[name] = spec;
  write(join(root, 'package.json'), { name: 'app', dependencies, devDependencies });
  for (const [name, version] of Object.entries(installed)) write(join(root, 'node_modules', name, 'package.json'), { name, version });
  return root;
}

const manifest = (root: string, extra: object) => write(join(root, 'package.json'), { name: 'app', ...extra });

describe('readFrameworkState', () => {
  it('reads the version when every package is installed in it', () => {
    const state = readFrameworkState(app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0', marmeon: '1.1.0' }, { '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0', marmeon: '1.1.0' }, ['marmeon']));
    expect(state).toMatchObject({ ok: true, version: { major: 1, minor: 1, patch: 0 } });
    expect(state.packages.map((listed) => [listed.name, listed.group])).toEqual([['@marmeon/core', 'dependencies'], ['@marmeon/http', 'dependencies'], ['marmeon', 'devDependencies']]);
  });

  it.each(['^1.1.0', '~1.1.0', '>= 1.0.0', '>=1.1.0 <2.0.0', '>= 1.1.0 < 2.0.0', '^1.0.0 || ^2.0.0', '^1.0.0||^2.0.0', '1.0.0 - 2.0.0', '>=1.1.0 <2.0.0', '1.x', '1.0.0 - 1.2.0', '^1.0.0 || ^2.0.0', 'latest', '1.1.0-rc.1'])('accepts the registry spec %s, which the upgrade pins', (spec) => {
    expect(readFrameworkState(app({ '@marmeon/core': spec }, { '@marmeon/core': '1.1.2' }))).toMatchObject({ ok: true, version: { text: '1.1.2' } });
  });

  it('takes the installed marmeon when @marmeon/core is not listed, and it must bring its own core', () => {
    const root = app({ marmeon: '1.2.0' }, { marmeon: '1.2.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed' });
    write(join(root, 'node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.2.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, version: { text: '1.2.0' } });
  });

  it('refuses marmeon with a core in another version', () => {
    const root = app({ marmeon: '1.2.0' }, { marmeon: '1.2.0', '@marmeon/core': '1.1.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('@marmeon/core 1.1.0') });
  });

  it('refuses marmeon beside a package in another version when @marmeon/core is not listed', () => {
    const root = app({ marmeon: '1.2.0', '@marmeon/http': '1.1.0' }, { marmeon: '1.2.0', '@marmeon/http': '1.1.0', '@marmeon/core': '1.2.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('@marmeon/http') });
  });

  it('refuses mixed versions and names the package', () => {
    const state = readFrameworkState(app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.0.0' }, { '@marmeon/core': '1.1.0', '@marmeon/http': '1.0.0' }));
    expect(state).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('@marmeon/http is 1.0.0') });
    expect(state.ok ? '' : state.fix).toBeTruthy();
  });

  it('refuses a second copy of a package', () => {
    const root = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: '1.1.0', dependencies: { '@marmeon/core': '1.0.0' } });
    write(join(root, 'node_modules/@marmeon/http/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('@marmeon/http 1.1.0 uses @marmeon/core 1.0.0') });
  });

  it('finds a second core two levels down and one behind a peerDependency', () => {
    const deep = app({ '@marmeon/core': '1.1.0', left: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(deep, 'node_modules/left/package.json'), { name: 'left', version: '1.0.0', dependencies: { right: '1.0.0' } });
    write(join(deep, 'node_modules/left/node_modules/right/package.json'), { name: 'right', version: '1.0.0', dependencies: { '@marmeon/core': '1.0.0' } });
    write(join(deep, 'node_modules/left/node_modules/right/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(deep)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('right 1.0.0 uses @marmeon/core 1.0.0') });
    const peer = app({ '@marmeon/core': '1.1.0', other: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(peer, 'node_modules/other/package.json'), { name: 'other', version: '1.0.0', peerDependencies: { '@marmeon/core': '*' } });
    write(join(peer, 'node_modules/other/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(peer)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('other 1.0.0 uses @marmeon/core 1.0.0') });
  });

  it("takes the app's packages from the app, not from a directory above it", () => {
    const outer = realpathSync(tempDir('marmeon-framework-'));
    write(join(outer, 'node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.1.0' });
    write(join(outer, 'app/package.json'), { name: 'app', dependencies: { '@marmeon/core': '1.1.0' } });
    expect(readFrameworkState(join(outer, 'app'))).toMatchObject({ ok: false, reason: 'not-installed' });
  });

  it.each(['workspace:*', 'catalog:', 'file:../core', 'link:../core', 'npm:evil@1.1.0', 'git+https://example.com/core.git', '../core', 'user/core', '..', '.', 'core.tgz', 'marmeon-core-1.1.0.tgz', 'x.tar.gz', '--registry=x', '1.0.0 --foo', '', '1.0.0 -- 2.0.0', '>= ../x', '>= file:x', '>= npm:evil@1', '>=1.0.0 ../x', '1.0.0-rc.tgz', '1-x.tgz', '1.0.0+x.tar', 'x-.tgz', '1.0.0-a.tar.gz', '1.0.0-RC.TGZ'])('refuses the spec %j and quotes it', (spec) => {
    expect(readFrameworkState(app({ '@marmeon/core': spec }, { '@marmeon/core': '1.1.0' }))).toMatchObject({ ok: false, reason: 'not-from-registry', message: `@marmeon/core is listed as "${spec}", which is not a version from a registry`, fix: expect.stringContaining('registry') });
  });

  it.each([
    ['overrides', { overrides: { '@marmeon/core': 'file:x' } }],
    ['nested overrides', { overrides: { other: { '@marmeon/core': '1.0.0' } } }],
    ['pnpm.overrides', { pnpm: { overrides: { '@marmeon/core': '1.0.0' } } }],
    ['resolutions', { resolutions: { 'marmeon': '1.0.0' } }],
  ])('refuses an override of a framework package in %s', (_name, extra) => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, ...extra });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it('accepts an override of another package', () => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, overrides: { 'left-pad': '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
  });

  it('accepts the pnpm-workspace.yaml the starter writes, and refuses one that overrides a framework package or that it cannot read', () => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    const yaml = join(root, 'pnpm-workspace.yaml');
    write(yaml, "# Save packages in the version installed, not as a range: every @marmeon/* package must have the app's version.\nsaveExact: true\n");
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    write(yaml, 'overrides:\n  "@marmeon/core": file:vendor/core.tgz\nsaveExact: true\n');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    write(yaml, 'overrides:\n  left-pad: 1.0.0\nhoistPattern: false\n');
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    write(yaml, 'overrides: { "@marmeon/core": "file:x" }\n');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
    write(yaml, 'overrides: &o\n  left-pad: 1.0.0\n');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('refuses a package that is listed and not installed', () => {
    expect(readFrameworkState(app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0' }))).toMatchObject({ ok: false, reason: 'not-installed', message: '@marmeon/http is not installed' });
    expect(readFrameworkState(app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, {}))).toMatchObject({ ok: false, reason: 'not-installed', message: '@marmeon/core, @marmeon/http are not installed' });
  });

  it('refuses an app without a framework package', () => {
    expect(readFrameworkState(app({ react: '19.0.0' }, {}))).toMatchObject({ ok: false, reason: 'no-framework', fix: expect.stringContaining('Marmeon app') });
    expect(readFrameworkState(app({ '@marmeon/http': '1.1.0' }, { '@marmeon/http': '1.1.0' }))).toMatchObject({ ok: false, reason: 'no-framework' });
  });

  it('refuses a listed name that looks like a framework package and is not a valid name', () => {
    expect(readFrameworkState(app({ '@marmeon/core': '1.1.0', '@marmeon/--registry=x': '1.1.0' }, { '@marmeon/core': '1.1.0' }))).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('reads a package listed in two groups when the spec is the same, and refuses different specs', () => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, devDependencies: { '@marmeon/core': '1.1.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, packages: [{ name: '@marmeon/core', group: 'dependencies' }] });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, optionalDependencies: { '@marmeon/core': '^1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable', message: expect.stringContaining('dependencies') });
  });

  it('reads optionalDependencies', () => {
    const root = app({}, { '@marmeon/core': '1.1.0' });
    manifest(root, { optionalDependencies: { '@marmeon/core': '1.1.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, packages: [{ group: 'optionalDependencies' }] });
  });

  it('refuses a group that is not an object and a spec that is not a string', () => {
    const root = app({}, { '@marmeon/core': '1.1.0' });
    for (const bad of [['x'], 'x', null, 1]) {
      manifest(root, { dependencies: bad });
      expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
    }
    manifest(root, { dependencies: { '@marmeon/core': 1 } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it.each([[1, 'unreadable'], [null, 'unreadable'], [['1.1.0'], 'unreadable'], ['not-a-version', 'unreadable'], ['^1.1.0', 'unreadable'], [undefined, 'unreadable']])('refuses an installed @marmeon/core whose version is %j as %s', (version, reason) => {
    const root = app({ '@marmeon/core': '1.1.0' }, {});
    write(join(root, 'node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason });
  });

  it('judges the first package.json Node would load, also when its version is not a string, as check does', () => {
    const root = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: 12 });
    expect(packagesCheck(root).report.status).toBe('failed');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
    const nested = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' });
    write(join(nested, 'node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: '1.1.0', dependencies: { '@marmeon/core': '1.1.0' } });
    write(join(nested, 'node_modules/@marmeon/http/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: 12 });
    expect(readFrameworkState(nested)).toMatchObject({ ok: false, reason: 'mixed' });
  });

  it('keeps check as it was for a package.json that is an array', () => {
    const root = realpathSync(tempDir('marmeon-framework-'));
    writeFileSync(join(root, 'package.json'), '[]');
    expect(packagesCheck(root).report.status).toBe('skipped');
  });

  it('refuses a missing and an unreadable package.json', () => {
    const root = realpathSync(tempDir('marmeon-framework-'));
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'no-manifest', fix: expect.stringContaining('root') });
    writeFileSync(join(root, 'package.json'), '{ nope');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
    writeFileSync(join(root, 'package.json'), '[]');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('reports a second copy of a direct package once, without "undefined"', () => {
    const root = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.0.0' }, { '@marmeon/core': '1.1.0', '@marmeon/http': '1.0.0' });
    const state = readFrameworkState(root);
    expect(state.ok ? '' : state.message).not.toContain('undefined');
    expect(state.ok ? '' : state.message.split('; ')).toHaveLength(1);
  });

  it('walks the devDependencies of the app: a second core below a third-party one, behind its peer, and below a framework package reached through another', () => {
    const below = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(below, { dependencies: { '@marmeon/core': '1.1.0' }, devDependencies: { tool: '1.0.0' } });
    write(join(below, 'node_modules/tool/package.json'), { name: 'tool', version: '1.0.0', dependencies: { helper: '1.0.0' } });
    write(join(below, 'node_modules/tool/node_modules/helper/package.json'), { name: 'helper', version: '1.0.0', dependencies: { '@marmeon/core': '1.0.0' } });
    write(join(below, 'node_modules/tool/node_modules/helper/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(below)).toMatchObject({ ok: false, reason: 'mixed' });

    const peer = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(peer, { dependencies: { '@marmeon/core': '1.1.0' }, devDependencies: { tool: '1.0.0' } });
    write(join(peer, 'node_modules/tool/package.json'), { name: 'tool', version: '1.0.0', peerDependencies: { '@marmeon/core': '*' } });
    write(join(peer, 'node_modules/tool/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(peer)).toMatchObject({ ok: false, reason: 'mixed' });

    const through = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' });
    manifest(through, { dependencies: { '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, devDependencies: { '@marmeon/testing': '1.1.0' } });
    write(join(through, 'node_modules/@marmeon/testing/package.json'), { name: '@marmeon/testing', version: '1.1.0', dependencies: { '@marmeon/http': '1.1.0' } });
    write(join(through, 'node_modules/@marmeon/testing/node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: '1.1.0', dependencies: { '@marmeon/core': '1.0.0' } });
    write(join(through, 'node_modules/@marmeon/testing/node_modules/@marmeon/http/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(through)).toMatchObject({ ok: false, reason: 'mixed' });
  });

  it('survives a dependency cycle and reads each package of it a bounded number of times (the walk ends)', { timeout: 10_000 }, () => {
    const root = app({ '@marmeon/core': '1.1.0', left: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/left/package.json'), { name: 'left', version: '1.0.0', dependencies: { right: '1.0.0' } });
    write(join(root, 'node_modules/right/package.json'), { name: 'right', version: '1.0.0', dependencies: { left: '1.0.0' } });
    reads.clear();
    limit.on = true;
    onTestFinished(() => {
      limit.on = false;
    });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    expect(reads.get(join(root, 'node_modules/left/package.json'))).toBeLessThanOrEqual(3);
    expect(reads.get(join(root, 'node_modules/right/package.json'))).toBeLessThanOrEqual(3);
  });

  it('judges the first package.json Node loads: a nested core without a version is mixed, one that cannot be parsed is unreadable', () => {
    for (const [nested, reason] of [[{ name: '@marmeon/core', main: 'evil.js' }, 'mixed'], ['{ nope', 'unreadable']] as const) {
      const root = app({ '@marmeon/core': '1.1.0', '@marmeon/http': '1.1.0' }, { '@marmeon/core': '1.1.0' });
      write(join(root, 'node_modules/@marmeon/http/package.json'), { name: '@marmeon/http', version: '1.1.0', dependencies: { '@marmeon/core': '1.1.0' } });
      write(join(root, 'node_modules/@marmeon/http/node_modules/@marmeon/core/package.json'), nested);
      expect(readFrameworkState(root)).toMatchObject({ ok: false, reason });
    }
  });

  it('refuses a listed package whose nearest package.json has no version or cannot be parsed', () => {
    for (const own of [{ name: '@marmeon/core' }, '{ nope']) {
      const root = app({ '@marmeon/core': '1.1.0' }, {});
      write(join(root, 'node_modules/@marmeon/core/package.json'), own);
      expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable' });
    }
  });

  it('judges a framework package that is listed only in peerDependencies', () => {
    const root = app({}, { '@marmeon/core': '1.2.0', '@marmeon/http': '1.0.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.2.0' }, peerDependencies: { '@marmeon/http': '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('@marmeon/http is 1.0.0') });
  });

  it('compares the installed copy of a framework package whatever spec declared it', () => {
    const root = app({ '@marmeon/core': '1.1.0', other: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/other/package.json'), { name: 'other', version: '1.0.0', dependencies: { '@marmeon/core': 'npm:evil@1.0.0' } });
    write(join(root, 'node_modules/other/node_modules/@marmeon/core/package.json'), { name: 'evil', version: '1.0.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'mixed' });
  });

  it('reports a second copy under a third-party package once', () => {
    const root = app({ '@marmeon/core': '1.1.0', other: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/other/package.json'), { name: 'other', version: '1.0.0', dependencies: { '@marmeon/core': '1.0.0' } });
    write(join(root, 'node_modules/other/node_modules/@marmeon/core/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    const problems = problemsAgainst(root, '@marmeon/core', { transitive: true, strict: true })!.filter((problem) => problem.severity === 'error');
    expect(problems).toHaveLength(1);
  });

  it('compares a framework package installed under another name, as a direct dependency and through a plugin', () => {
    const direct = app({ '@marmeon/core': '1.1.0', legacy: 'npm:@marmeon/core@1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(direct, 'node_modules/legacy/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(direct)).toMatchObject({ ok: false, reason: 'not-from-registry', message: expect.stringContaining('legacy') });
    const plugin = app({ '@marmeon/core': '1.1.0', plugin: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(plugin, 'node_modules/plugin/package.json'), { name: 'plugin', version: '1.0.0', dependencies: { legacy: 'npm:@marmeon/core@1.0.0' } });
    write(join(plugin, 'node_modules/plugin/node_modules/legacy/package.json'), { name: '@marmeon/core', version: '1.0.0' });
    expect(readFrameworkState(plugin)).toMatchObject({ ok: false, reason: 'mixed', message: expect.stringContaining('legacy (@marmeon/core) 1.0.0') });
  });

  it('refuses a package in the tree whose package.json cannot be read, and names where it is', () => {
    for (const broken of ['{ nope', '[]']) {
      const root = app({ '@marmeon/core': '1.1.0', plugin: '1.0.0' }, { '@marmeon/core': '1.1.0' });
      write(join(root, 'node_modules/plugin/package.json'), broken);
      expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'unreadable', message: expect.stringContaining('node_modules/plugin') });
    }
  });

  it('keeps going past a dependency that is not installed', () => {
    const root = app({ '@marmeon/core': '1.1.0', plugin: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    write(join(root, 'node_modules/plugin/package.json'), { name: 'plugin', version: '1.0.0', dependencies: { absent: '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
  });

  it('reads a peer range beside a dev pin as no contradiction, and judges a peer-only listing', () => {
    const root = app({}, { '@marmeon/core': '1.2.0' });
    manifest(root, { peerDependencies: { '@marmeon/core': '^1.0.0' }, devDependencies: { '@marmeon/core': '1.2.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, packages: [{ name: '@marmeon/core', spec: '1.2.0', group: 'devDependencies' }] });
    manifest(root, { devDependencies: { '@marmeon/core': '1.2.0' }, peerDependencies: { '@marmeon/core': '^1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, packages: [{ spec: '1.2.0', group: 'devDependencies' }] });
    manifest(root, { peerDependencies: { '@marmeon/core': '^1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true, packages: [{ group: 'peerDependencies' }] });
    manifest(root, { peerDependencies: { '@marmeon/core': 'file:../core' }, devDependencies: { '@marmeon/core': '1.2.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it('judges the spec of a package listed in peerDependencies', () => {
    const root = app({}, { '@marmeon/core': '1.2.0' });
    manifest(root, { peerDependencies: { '@marmeon/core': 'workspace:*' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it.each([' @marmeon/core', ' @marmeon/core ', 'foo > @marmeon/core', 'foo >@marmeon/core@1.0.0', 'parent/@marmeon/core', 'marmeon @1.0.0', 'marmeon@1.0.0 '])('finds the padded or nested key %j in package.json overrides, in a patch and in the yaml', (key) => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, overrides: { [key]: '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, pnpm: { patchedDependencies: { [key]: 'patches/x.patch' } } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' } });
    write(join(root, 'pnpm-workspace.yaml'), `overrides:\n  "${key}": 1.0.0\n`);
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    write(join(root, 'pnpm-workspace.yaml'), `patchedDependencies:\n  "${key}": patches/x.patch\n`);
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it.each(['npm: @marmeon/core@1', 'npm:  @marmeon/core', ' npm:@marmeon/core@1', ' npm: @marmeon/core '])('finds the alias value %j', (value) => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, overrides: { other: value } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    write(join(root, 'pnpm-workspace.yaml'), `overrides:\n  other: "${value}"\n`);
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it('gives up on a walk longer than maxWalk and refuses', () => {
    const root = app({ '@marmeon/core': '1.1.0', a: '1.0.0' }, { '@marmeon/core': '1.1.0' });
    const chain = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const [index, name] of chain.entries()) write(join(root, 'node_modules', name, 'package.json'), { name, version: '1.0.0', dependencies: chain[index + 1] === undefined ? {} : { [chain[index + 1]!]: '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    expect(readFrameworkState(root, { maxWalk: 3 })).toMatchObject({ ok: false, reason: 'unreadable', message: expect.stringContaining('followed') });
  });

  it('refuses a patched framework package, in package.json and in pnpm-workspace.yaml', () => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, pnpm: { patchedDependencies: { '@marmeon/core@1.1.0': 'patches/core.patch' } } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry', fix: expect.stringContaining('remove the patch') });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, pnpm: { patchedDependencies: { 'left-pad@1.0.0': 'patches/x.patch' } } });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    write(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies:\n  "@marmeon/core@1.1.0": patches/core.patch\n');
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry', fix: expect.stringContaining('remove the patch') });
  });

  it('does not take an unrelated override for one of a framework package, and finds a selector and an npm alias', () => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    const withOverrides = (overrides: object) => manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, overrides });
    withOverrides({ 'vite-plugin-marmeonish': '2.0.0', '@scope/marmeon': '1.0.0', other: 'npm:left-pad@1.0.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: true });
    withOverrides({ 'some-package>@marmeon/core': '1.0.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    withOverrides({ '@marmeon/core@<1.1.0': '1.1.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    withOverrides({ other: 'npm:@marmeon/core@1.0.0' });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
  });

  it.each(['@marmeon/core@npm:@evil/x@1', '@marmeon/core@https://example.com/core.tgz', '@marmeon/core@github:user/repo', 'marmeon@1.0.0', 'marmeon@npm:@evil/x@1'])('finds the framework package in the key %s, as an override and as a patch', (key) => {
    const root = app({ '@marmeon/core': '1.1.0' }, { '@marmeon/core': '1.1.0' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, overrides: { [key]: '1.0.0' } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry' });
    manifest(root, { dependencies: { '@marmeon/core': '1.1.0' }, pnpm: { patchedDependencies: { [key]: 'patches/x.patch' } } });
    expect(readFrameworkState(root)).toMatchObject({ ok: false, reason: 'not-from-registry', fix: expect.stringContaining('patch') });
  });
});

describe('readPnpmWorkspace', () => {
  /** The exact text the starter writes next to a new app. */
  async function starterFile(): Promise<string> {
    const template = (await import(pathToFileURL(join(repo, 'packages/create-marmeon/src/template.ts')).href)) as { SAVE_EXACT_PNPM: string };
    return `${template.SAVE_EXACT_PNPM}\n`;
  }

  const read = (text: string) => {
    const file = join(realpathSync(tempDir('marmeon-workspace-')), 'pnpm-workspace.yaml');
    writeFileSync(file, text);
    return readPnpmWorkspace(file);
  };

  it('reads the file the starter writes', async () => {
    expect(read(await starterFile())).toEqual({ readable: true, packages: false, overrides: [], patchedDependencies: [] });
  });

  it('reads a plain overrides block, a patchedDependencies block and a packages list', () => {
    expect(read("# a comment\noverrides:\n  left-pad: 1.0.0 # trailing\n  '@scope/pkg@<2': ^2.0.0\n  \"quoted\": npm:other@1.0.0\npackages:\n  - apps/*\npatchedDependencies:\n  left-pad@1.0.0: patches/a.patch\n")).toEqual({
      readable: true,
      packages: true,
      overrides: [{ key: 'left-pad', value: '1.0.0' }, { key: '@scope/pkg@<2', value: '^2.0.0' }, { key: 'quoted', value: 'npm:other@1.0.0' }],
      patchedDependencies: ['left-pad@1.0.0'],
    });
  });

  it('reads quoted scalars as pnpm writes them', () => {
    expect(read("onlyBuiltDependencies:\n  - '@swc/core'\n  - \"esbuild\"\n")).toEqual({ readable: true, packages: false, overrides: [], patchedDependencies: [] });
    expect(read("overrides:\n  '@marmeon/core': '1.0.0'\n")).toMatchObject({ readable: true, overrides: [{ key: '@marmeon/core', value: '1.0.0' }] });
    expect(read("packages:\n  - 'apps/*' # members\n")).toMatchObject({ readable: true, packages: true });
  });

  it('reads nested mappings at any depth outside overrides, patchedDependencies and packages', () => {
    expect(read('catalogs:\n  default:\n    react: 19\n    react-dom: 19\n  legacy:\n    react: 18\n')).toEqual({ readable: true, packages: false, overrides: [], patchedDependencies: [] });
    expect(read("packageExtensions:\n  'react-redux@*':\n    peerDependencies:\n      react-dom: '*' # comment\n    optionalDependencies:\n      x: 1\nsaveExact: true\n")).toMatchObject({ readable: true });
    expect(read('catalog:\n  a:\n  b: 1\n')).toMatchObject({ readable: true });
  });

  it('names the first line it cannot read', () => {
    expect(read('saveExact: true\n# fine\noverrides:\n  a:\n    b: 1\n')).toEqual({ readable: false, line: 4 });
    expect(read('catalogs:\n  default:\n        react: 19\n')).toEqual({ readable: false, line: 3 });
  });

  it('reads CRLF line ends as LF', () => {
    expect(read('saveExact: true\r\noverrides:\r\n  left-pad: 1.0.0\r\n')).toMatchObject({ readable: true, overrides: [{ key: 'left-pad', value: '1.0.0' }] });
  });

  it.each([
    ['a whole document indented', '  overrides:\n    "@marmeon/core": 1.0.0\n  packages:\n    - x\n'],
    ['an escaped key', 'overrides:\n  "@\\x6darmeon/core": 1.0.0\n'],
    ['an anchor and a merge key', 'x: &-o\n  a: 1\noverrides:\n  << : *-o\n'],
    ['a merge key without a space', 'overrides:\n  <<: foo\n'],
    ['a document marker', '---\noverrides:\n  a: 1\n'],
    ['a document end marker', 'saveExact: true\n...\n'],
    ['flow style', 'overrides: { "@marmeon/core": "1.0.0" }\n'],
    ['a flow list', 'hoistPattern: []\n'],
    ['an alias', 'overrides: *o\n'],
    ['an anchor', 'overrides: &o\n  a: 1\n'],
    ['a block scalar', 'overrides: |\n  a: 1\n'],
    ['a folded scalar', 'x: >\n  a\n'],
    ['a tab', 'overrides:\n\ta: 1\n'],
    ['three spaces', 'overrides:\n   a: 1\n'],
    ['six spaces', 'overrides:\n      a: 1\n'],
    ['an escaped quote in single quotes', "overrides:\n  'a\\'b': 1\n"],
    ['a doubled single quote', "overrides:\n  'a''b': 1\n"],
    ['an escaped quote in double quotes', 'overrides:\n  "a\\"b": 1\n'],
    ['an unterminated quote', "overrides:\n  a: 'unterminated\n"],
    ['text after a closing quote', "overrides:\n  a: 'x' y\n"],
    ['a value with a colon and space', 'overrides:\n  a: b: c\n'],
    ['an inline value for overrides', 'overrides: a\n'],
    ['a nested line before any key', '  a: 1\n'],
    ['a lone CR', 'saveExact: true\roverrides:\n'],
    ['a jump of four spaces', 'catalogs:\n  default:\n      react: 19\n'],
    ['a nested map under overrides', 'overrides:\n  a:\n    b: 1\n'],
    ['a nested map under patchedDependencies', 'patchedDependencies:\n  a:\n    b: x\n'],
    ['an indicator after a key under overrides', 'overrides:\n  a: - b\n'],
    ['a question mark after a key under overrides', 'overrides:\n  a: ? b\n'],
    ['a key under packages', 'packages:\n  a: b\n'],
    ['a list under overrides', 'overrides:\n  - a\n'],
    ['a deeper line after a scalar', 'catalogs:\n  a: 1\n    b: 2\n'],
    ['a byte order mark', '\uFEFFsaveExact: true\n'],
    ['a key with an indicator', 'overrides:\n  ? a: 1\n'],
    ['a value that starts with an indicator', 'overrides:\n  a: !!str x\n'],
    ['a value that starts with a star', 'overrides:\n  a: *o\n'],
  ])('refuses %s', (_name, text) => {
    expect(read(text)).toMatchObject({ readable: false, line: expect.any(Number) });
  });

  it('does not read a file that is not there', () => {
    expect(readPnpmWorkspace(join(realpathSync(tempDir('marmeon-workspace-')), 'missing.yaml'))).toEqual({ readable: false, line: 1 });
  });
});
