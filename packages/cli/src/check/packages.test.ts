import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { packageAdvice, packageProblems, packagesCheck, problemsAgainst } from './packages.ts';

interface Installed {
  version: string;
  spec?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  nested?: Record<string, Installed>;
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function install(modules: string, packages: Record<string, Installed>): void {
  for (const [name, { version, dependencies, nested }] of Object.entries(packages)) {
    write(join(modules, name, 'package.json'), { name, version, dependencies });
    if (nested) install(join(modules, name, 'node_modules'), nested);
  }
}

/** An app that lists `packages` and has them installed in `node_modules`, as a flat install lays them out. */
function app(packages: Record<string, Installed>): string {
  const root = realpathSync(tempDir('marmeon-packages-'));
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const [name, { version, spec, dev }] of Object.entries(packages)) (dev ? devDependencies : dependencies)[name] = spec ?? version;
  write(join(root, 'package.json'), { name: 'shop', dependencies, devDependencies });
  install(join(root, 'node_modules'), packages);
  return root;
}

const RC = '1.0.0-rc.1';

describe('packageProblems', () => {
  it('finds nothing in an app whose packages are all in one version', () => {
    const root = app({ '@marmeon/core': { version: RC }, '@marmeon/storage': { version: RC, dependencies: { '@marmeon/core': RC } }, marmeon: { version: RC, dev: true } });
    expect(packageProblems(root)).toEqual([]);
    expect(packageAdvice(root)).toEqual([]);
    expect(packagesCheck(root).report).toMatchObject({ name: 'packages', status: 'passed' });
  });

  it('names a package in another version, both versions and the command that fixes it', () => {
    const root = app({ '@marmeon/core': { version: RC }, '@marmeon/storage': { version: '0.4.0' } });
    expect(packageProblems(root)).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: `@marmeon/storage is 0.4.0, the app's framework is ${RC} — install it in that version`,
        fix: `pnpm add -E @marmeon/storage@${RC}`,
      }),
    ]);
    expect(packagesCheck(root).report.status).toBe('failed');
    expect(packageAdvice(root)[0]).toContain(`pnpm add -E @marmeon/storage@${RC}`);
  });

  it('does not print a version it cannot read in an error either, whatever the manifest says', () => {
    const bad = '9.9.9\n! FAKE';
    const first = app({ '@marmeon/core': { version: RC }, '@marmeon/storage': { version: bad } });
    const nested = app({ '@marmeon/core': { version: RC }, '@marmeon/storage': { version: RC, dependencies: { '@marmeon/core': '0.4.0' }, nested: { '@marmeon/core': { version: bad } } } });
    const other = app({ '@marmeon/core': { version: RC }, 'some-plugin': { version: bad, dependencies: { '@marmeon/core': '0.9.0' }, nested: { '@marmeon/core': { version: bad } } } });
    for (const root of [first, nested, other]) {
      const problems = packageProblems(root)!;
      expect(problems).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('in a version that cannot be read') })]);
      for (const problem of problems) expect(problem.message).not.toContain('\n');
    }
  });

  it('does not print a version it cannot read in the error of the transitive walk', () => {
    const root = app({ '@marmeon/core': { version: RC }, 'some-plugin': { version: '2.0.0', nested: { '@marmeon/storage': { version: '9.9.9\n! FAKE' } } } });
    write(join(root, 'node_modules/some-plugin/package.json'), { name: 'some-plugin', version: '2.0.0', peerDependencies: { '@marmeon/storage': RC } });
    const problems = problemsAgainst(root, '@marmeon/core', { transitive: true })!;
    expect(problems).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('uses @marmeon/storage in a version that cannot be read') })]);
    expect(problems[0]?.message).not.toContain('\n');
  });

  it.each([
    ['key', '@marmeon/x\n! FAKE KEY/../../../y', undefined],
    ['name', '@marmeon/storage', '@marmeon/y\n! FAKE NAME'],
  ])('does not print a %s of a manifest that adds a line, in the error of the transitive walk', (_label, key, realName) => {
    const root = app({ '@marmeon/core': { version: RC }, 'some-plugin': { version: '2.0.0', nested: { [key]: { version: '0.4.0' } } } });
    write(join(root, 'node_modules/some-plugin/package.json'), { name: 'some-plugin', version: '2.0.0', peerDependencies: { [key]: RC } });
    if (realName !== undefined) write(join(root, 'node_modules/some-plugin/node_modules', key, 'package.json'), { name: realName, version: '0.4.0' });
    const problems = problemsAgainst(root, '@marmeon/core', { transitive: true })!;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error' });
    expect(problems[0]?.message).toContain('uses ');
    expect(problems[0]?.message).not.toContain('\n');
  });

  it('puts -D in the command for a package the app lists as a development dependency', () => {
    const root = app({ '@marmeon/core': { version: RC }, marmeon: { version: '0.4.0', dev: true } });
    expect(packageProblems(root)![0]?.fix).toBe(`pnpm add -E -D marmeon@${RC}`);
  });

  it('warns about a range, also when the installed version is the right one', () => {
    const root = app({ '@marmeon/core': { version: RC, spec: `^${RC}` } });
    expect(packageProblems(root)).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('pin it exactly'), fix: `pnpm add -E @marmeon/core@${RC}` })]);
    expect(packagesCheck(root).report.status).toBe('warning');
  });

  it("finds a second core that a package brings beside the app's", () => {
    const root = app({
      '@marmeon/core': { version: RC },
      '@marmeon/storage': { version: RC, dependencies: { '@marmeon/core': '0.4.0' }, nested: { '@marmeon/core': { version: '0.4.0' } } },
    });
    expect(packageProblems(root)).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: `@marmeon/storage ${RC} uses @marmeon/core 0.4.0, a second copy next to the app's ${RC} — install it in the app's version`,
        fix: `pnpm add -E @marmeon/core@${RC}`,
      }),
    ]);
  });

  it('reports a package in another version once, not again for what it pins', () => {
    const root = app({
      '@marmeon/core': { version: RC },
      '@marmeon/storage': { version: '0.4.0', dependencies: { '@marmeon/core': '0.4.0' }, nested: { '@marmeon/core': { version: '0.4.0' } } },
    });
    expect(packageProblems(root)).toHaveLength(1);
  });

  it('does not report workspace links or the 0.0.0 of a development checkout', () => {
    const root = app({
      '@marmeon/core': { version: '0.0.0', spec: 'workspace:*' },
      '@marmeon/storage': { version: '0.0.0', spec: 'workspace:*', dependencies: { '@marmeon/core': 'workspace:*' } },
      marmeon: { version: '0.0.0', spec: 'link:../../packages/cli', dev: true },
    });
    expect(packageProblems(root)).toEqual([]);
  });

  it('is skipped when the app has no framework package installed', () => {
    const root = app({});
    expect(packageProblems(root)).toBeUndefined();
    expect(packagesCheck(root).report).toMatchObject({ status: 'skipped', reason: 'no @marmeon/core installed' });
  });

  it('shows the command of the package manager whose lockfile the app has', () => {
    const packages = { '@marmeon/core': { version: RC }, '@marmeon/storage': { version: '0.4.0' }, marmeon: { version: '0.4.0', dev: true } };
    const withNpm = app(packages);
    writeFileSync(join(withNpm, 'package-lock.json'), '{}');
    expect(packageProblems(withNpm)!.map((problem) => problem.fix)).toEqual([`npm install -E -D marmeon@${RC}`, `npm install -E @marmeon/storage@${RC}`]);
    const both = app(packages);
    writeFileSync(join(both, 'package-lock.json'), '{}');
    writeFileSync(join(both, 'pnpm-lock.yaml'), '');
    expect(packageProblems(both)![1]?.fix).toBe(`pnpm add -E @marmeon/storage@${RC}`);
  });

  it('finds a second core that a package of someone else brings', () => {
    const root = app({ '@marmeon/core': { version: RC }, 'some-plugin': { version: '2.0.0', dependencies: { '@marmeon/core': '0.9.0' }, nested: { '@marmeon/core': { version: '0.9.0' } } } });
    expect(packageProblems(root)).toEqual([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining(`some-plugin 2.0.0 uses @marmeon/core 0.9.0, a second copy next to the app's ${RC}`) }),
    ]);
  });

  it('does not warn about the range of a package it already reports', () => {
    const root = app({ '@marmeon/core': { version: RC }, '@marmeon/storage': { version: '0.4.0', spec: '^0.4.0' } });
    expect(packageProblems(root)).toHaveLength(1);
  });

  it('says that package.json could not be read, not that core is missing', () => {
    const root = realpathSync(tempDir('marmeon-packages-'));
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(packagesCheck(root).report).toMatchObject({ status: 'error', reason: 'the packages could not be read: package.json could not be read' });
  });
});

/**
 * A pnpm-like layout built with links: the app lists `@marmeon/core`, `@marmeon/storage` and a package `ui` of someone else. `ui` declares
 * `@marmeon/storage` in `group` and resolves it from its own real directory, to the copy the app uses (`shared`) or to a second directory.
 */
interface Workspace {
  group?: 'dependencies' | 'peerDependencies';
  /** How `ui` spells the range of the declared package. */
  spec?: string;
  dev?: boolean;
  /** `ui` resolves the package to the directory the app resolves it to. */
  shared?: boolean;
  /** The version of the second copy. */
  copy?: string;
  /** `ui` has no copy of its own to resolve. */
  unresolved?: boolean;
  /** The app has no `@marmeon/storage`. */
  missing?: boolean;
  /** The declared package (default `@marmeon/storage`). */
  declared?: string;
  /** `ui` lives outside the app's directory, so that nothing resolves from its real directory. */
  outside?: boolean;
  /** The app lists no `@marmeon/core` (it is installed). */
  unlisted?: boolean;
}

function real(dir: string, manifest: Record<string, unknown>): string {
  write(join(dir, 'package.json'), manifest);
  return dir;
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}

function workspace({ group = 'dependencies', spec = RC, dev = false, shared = false, copy = RC, unresolved = false, missing = false, declared = '@marmeon/storage', outside = false, unlisted = false }: Workspace = {}): string {
  const root = realpathSync(tempDir('marmeon-copies-'));
  const store = join(root, 'node_modules/.pnpm');
  const modules = join(root, 'node_modules');
  const listed: Record<string, string> = { ...(unlisted ? {} : { '@marmeon/core': RC }), ...(missing ? {} : { [declared]: RC }), ...(dev ? {} : { ui: '1.0.0' }) };
  write(join(root, 'package.json'), { name: 'shop', dependencies: listed, ...(dev ? { devDependencies: { ui: '1.0.0' } } : {}) });
  link(real(join(store, 'core/node_modules/@marmeon/core'), { name: '@marmeon/core', version: RC }), join(modules, '@marmeon/core'));
  const own = missing ? undefined : real(join(store, 'own/node_modules', declared), { name: declared, version: RC });
  if (own !== undefined) link(own, join(modules, declared));
  const ui = real(join(outside ? realpathSync(tempDir('marmeon-outside-')) : store, 'ui/node_modules/ui'), { name: 'ui', version: '1.0.0', [group]: { [declared]: spec } });
  link(ui, join(modules, 'ui'));
  if (!unresolved) link(shared && own !== undefined ? own : real(join(store, 'other/node_modules', declared), { name: declared, version: copy }), join(dirname(ui), declared));
  return root;
}

describe('a second copy of a framework package in one version', () => {
  const finding = (root: string) => packageProblems(root)!.filter((problem) => problem.severity === 'warning');

  it.each([
    ['a dependency', { group: 'dependencies' }],
    ['a peer', { group: 'peerDependencies' }],
    ['a workspace range', { spec: 'workspace:*' }],
    ['a dependency of a development dependency', { dev: true }],
  ] as const)('warns about the copy a package of someone else resolves as %s', (_label, options) => {
    const root = workspace(options);
    expect(packageProblems(root)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: 'ui resolves another copy of @marmeon/storage (the same version, other peers)',
        fix: "align the peers' versions, then pnpm dedupe",
        docs: 'docs/package-development.md#one-copy-of-a-framework-package',
        rule: 'marmeon(packages)',
      }),
    ]);
    expect(packagesCheck(root).report.status).toBe('warning');
    expect(packageAdvice(root)).toEqual([`ui resolves another copy of @marmeon/storage (the same version, other peers): align the peers' versions, then pnpm dedupe`]);
  });

  it('says it once when a package declares the copy twice', () => {
    const root = workspace();
    const ui = join(root, 'node_modules/.pnpm/ui/node_modules/ui');
    write(join(ui, 'package.json'), { name: 'ui', version: '1.0.0', dependencies: { '@marmeon/storage': RC }, peerDependencies: { '@marmeon/storage': RC } });
    expect(finding(root)).toHaveLength(1);
  });

  it('finds nothing when both links lead to one real directory', () => {
    const root = workspace({ shared: true });
    expect(packageProblems(root)).toEqual([]);
    expect(packageAdvice(root)).toEqual([]);
  });

  it('finds nothing for a package that reaches the same directory as the app by walking up from its real directory', () => {
    expect(packageProblems(workspace({ unresolved: true }))).toEqual([]);
  });

  it('finds nothing for a package that does not resolve from the real directory of the package at all', () => {
    expect(packageProblems(workspace({ unresolved: true, outside: true }))).toEqual([]);
  });

  it('finds nothing for a package that is not a framework package, in two directories at one version', () => {
    const root = workspace({ declared: 'react' });
    expect(packageProblems(root)).toEqual([]);
    expect(packageAdvice(root, 'copies')).toEqual([]);
  });

  it.each([
    ['a peer', { group: 'peerDependencies' }],
    ['a workspace range', { spec: 'workspace:*' }],
  ] as const)('warns, never an error, about a copy in another version that %s declares', (_label, options) => {
    const root = workspace({ ...options, copy: '0.4.0' });
    expect(packageProblems(root)).toEqual([
      expect.objectContaining({ severity: 'warning', message: `ui resolves its own copy of @marmeon/storage 0.4.0, the app has ${RC}`, fix: "align the peers' versions, then pnpm dedupe" }),
    ]);
    expect(packagesCheck(root).report.status).toBe('warning');
  });

  it('does not print a version it cannot read, whatever the manifest says', () => {
    const root = workspace({ group: 'peerDependencies', copy: '1.0.0\nforged line' });
    const [problem] = packageProblems(root)!;
    expect(problem?.message).toBe(`ui resolves its own copy of @marmeon/storage in a version that cannot be read, the app has ${RC}`);
    expect(packageAdvice(root).join('')).not.toContain('\n');
  });

  it.each([
    ['in a name that is not a package of the framework', '@marmeon/../evil\nforged'],
    ['in a name with a line break', '@marmeon/evil\nforged'],
  ])('skips a key of a foreign manifest %s', (_label, key) => {
    for (const copy of [RC, '0.4.0']) {
      const root = workspace();
      const ui = join(root, 'node_modules/.pnpm/ui/node_modules/ui');
      write(join(ui, 'package.json'), { name: 'ui', version: '1.0.0', dependencies: { [key]: RC }, peerDependencies: { [key]: RC } });
      write(join(root, 'node_modules/evil\nforged/package.json'), { name: 'evil', version: RC });
      write(join(root, 'node_modules/@marmeon/evil\nforged/package.json'), { name: 'evil', version: RC });
      write(join(ui, 'node_modules/evil\nforged/package.json'), { name: 'evil', version: copy });
      write(join(root, 'node_modules/.pnpm/ui/node_modules/@marmeon/evil\nforged/package.json'), { name: 'evil', version: copy });
      expect(packageProblems(root)).toEqual([]);
      expect(packageAdvice(root).join('')).not.toContain('\n');
      expect(packageAdvice(root, 'copies')).toEqual([]);
    }
  });

  it('gives nothing as copies where the app does not list the installed core', () => {
    const root = workspace({ unlisted: true });
    expect(packageProblems(root)).toBeUndefined();
    expect(packageAdvice(root, 'copies')).toEqual([]);
    expect(packageAdvice(workspace(), 'copies')).toHaveLength(1);
  });

  it('finds nothing when the app has no copy of the package to compare', () => {
    expect(packageProblems(workspace({ missing: true }))).toEqual([]);
  });

  it('leaves the CLI out: it is types only', () => {
    expect(packageProblems(workspace({ declared: 'marmeon' }))).toEqual([]);
  });

  it('keeps another version as the one error, with no warning beside it', () => {
    const root = workspace({ copy: '0.4.0' });
    const problems = packageProblems(root)!;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', message: expect.stringContaining('uses @marmeon/storage 0.4.0') });
    expect(problems.filter((problem) => problem.severity === 'warning')).toEqual([]);
  });

  it('leaves the check unable to run when a manifest cannot be read, not a thrown error', () => {
    const root = workspace();
    writeFileSync(join(root, 'package.json'), '{');
    expect(packagesCheck(root).report).toMatchObject({ status: 'error', reason: 'the packages could not be read: package.json could not be read' });
    expect(packageAdvice(root)).toEqual([]);
  });

  it('gives only the copies as advice when asked for those', () => {
    const root = workspace();
    expect(packageAdvice(root, 'copies')).toEqual([`ui resolves another copy of @marmeon/storage (the same version, other peers): align the peers' versions, then pnpm dedupe`]);
    const mixed = workspace({ copy: '0.4.0' });
    expect(packageAdvice(mixed)).toHaveLength(1);
    expect(packageAdvice(mixed, 'copies')).toEqual([]);
  });
});
