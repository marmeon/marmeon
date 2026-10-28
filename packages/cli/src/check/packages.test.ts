import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { packageAdvice, packageProblems, packagesCheck } from './packages.ts';

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
