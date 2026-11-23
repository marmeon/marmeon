import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

const blank = join(repo, 'apps/blank-app');
const version = (JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')) as { version: string }).version;

/**
 * A copy of the blank app with a command whose class takes a constructor argument and has no injection list (plain JavaScript, which
 * the loader leaves alone) — the start of the command fails with K3. `other` is an installed `@marmeon/redis` in that version.
 */
function appWithBrokenCommand(other?: string): string {
  const root = realpathSync(tempDir('marmeon-versions-'));
  cpSync(blank, root, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  mkdirSync(join(root, 'storage'));
  writeFileSync(join(root, 'modules/system/Broken.js'), "export class BrokenCommand {\n  static command = 'broken';\n  static description = 'Broken';\n  constructor(dependency) {\n    this.dependency = dependency;\n  }\n  handle() {}\n}\n");
  writeFileSync(
    join(root, 'modules/system/index.ts'),
    "import { defineModule } from '@marmeon/core';\nimport { BrokenCommand } from './Broken.js';\nexport default defineModule({ name: 'system', commands: [BrokenCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
  );
  if (other !== undefined) {
    // The blank app's node_modules, entry by entry, so that one more package can be installed beside them.
    const modules = join(root, 'node_modules');
    mkdirSync(join(modules, '@marmeon'), { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) if (entry !== '@marmeon') symlinkSync(join(blank, 'node_modules', entry), join(modules, entry));
    for (const entry of readdirSync(join(blank, 'node_modules/@marmeon'))) symlinkSync(join(blank, 'node_modules/@marmeon', entry), join(modules, '@marmeon', entry));
    mkdirSync(join(modules, '@marmeon/redis'));
    writeFileSync(join(modules, '@marmeon/redis/package.json'), JSON.stringify({ name: '@marmeon/redis', version: other }));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@marmeon/redis'] = other;
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  } else {
    symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  return root;
}

describe('a start that fails with K3', { timeout: 60_000 }, () => {
  it('names the @marmeon packages that are not in the version of the app', () => {
    const { code, stderr } = marmeon(appWithBrokenCommand('0.4.0'), ['broken']);
    expect(code).toBe(1);
    expect(stderr).toContain('[marmeon:K3]');
    expect(stderr).toContain(`@marmeon/redis is 0.4.0, the app's framework is ${version}`);
    expect(stderr).toContain(`pnpm add -E @marmeon/redis@${version}`);
  });

  it('says nothing about versions when they are all alike', () => {
    const { code, stderr } = marmeon(appWithBrokenCommand(), ['broken']);
    expect(code).toBe(1);
    expect(stderr).toContain('[marmeon:K3]');
    expect(stderr).not.toContain('not in one version');
  });
});

/**
 * `appWithBrokenCommand` with `@marmeon/redis` in the app's version and a package `ui` of someone else that brings a copy of it of its own
 * (`copy`), and the system module as `module` says: the K3 command, a module that throws when the app starts, or a command that fails when it runs.
 */
function appWithCopy(module: 'k3' | 'throws' | 'fails', copy: boolean, mismatch = false, pkg = 'ui'): string {
  const root = appWithBrokenCommand(version);
  const modules = join(root, 'node_modules');
  if (mismatch) {
    mkdirSync(join(modules, '@marmeon/mongo'));
    writeFileSync(join(modules, '@marmeon/mongo/package.json'), JSON.stringify({ name: '@marmeon/mongo', version: '0.4.0' }));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@marmeon/mongo'] = '0.4.0';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  }
  if (copy) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), dependencies: { ...JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies, [pkg]: '1.0.0' } }));
    mkdirSync(join(modules, `${pkg}/node_modules/@marmeon/redis`), { recursive: true });
    writeFileSync(join(modules, `${pkg}/package.json`), JSON.stringify({ name: pkg, version: '1.0.0', dependencies: { '@marmeon/redis': version } }));
    writeFileSync(join(modules, `${pkg}/node_modules/@marmeon/redis/package.json`), JSON.stringify({ name: '@marmeon/redis', version }));
  }
  if (module === 'throws') writeFileSync(join(root, 'modules/system/index.ts'), "throw new Error('the module does not start');\nexport default {};\n");
  if (module === 'fails') {
    writeFileSync(join(root, 'modules/system/Broken.js'), "export class FailsCommand {\n  static command = 'fails';\n  static description = 'Fails';\n  handle() {\n    throw new Error('the command fails');\n  }\n}\n");
    writeFileSync(
      join(root, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { FailsCommand } from './Broken.js';\nexport default defineModule({ name: 'system', commands: [FailsCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
  }
  return root;
}

describe('a second copy of a framework package in one version, at a failed start', { timeout: 60_000 }, () => {
  const COPY = 'ui resolves another copy of @marmeon/redis (the same version, other peers)';
  const MISMATCH = `@marmeon/mongo is 0.4.0, the app's framework is ${version}`;
  const VERSIONS = 'The @marmeon packages of this app are not in one version';
  const COPIES = 'A package of this app resolves its own copy of an @marmeon package';
  const all = (run: { stdout: string; stderr: string }) => run.stderr + run.stdout;
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('puts the mismatch under its heading and the copy under its own heading after a K3, each once', () => {
    const run = marmeon(appWithCopy('k3', true, true), ['broken']);
    const text = all(run);
    expect(run.code).toBe(1);
    expect(text).toContain('[marmeon:K3]');
    const versions = text.indexOf(VERSIONS);
    const mismatch = text.indexOf(MISMATCH);
    const copies = text.indexOf(COPIES);
    const copy = text.indexOf(COPY);
    expect(versions).toBeGreaterThan(-1);
    expect(mismatch).toBeGreaterThan(versions);
    expect(copies).toBeGreaterThan(mismatch);
    expect(copy).toBeGreaterThan(copies);
    expect(count(text, COPY)).toBe(1);
    expect(count(text, MISMATCH)).toBe(1);
  });

  it('names only the copy, under its own heading, after a start that failed otherwise, though a version differs', () => {
    const run = marmeon(appWithCopy('throws', true, true), ['unknown']);
    const text = all(run);
    expect(run.code).toBe(1);
    expect(text).toContain('Could not start the application');
    expect(text).toContain(COPIES);
    expect(text).toContain(COPY);
    expect(text).not.toContain(MISMATCH);
    expect(text).not.toContain('not in one version');
  });

  it('names nothing about copies after a failed marmeon start', () => {
    const run = marmeon(appWithCopy('throws', true), ['start']);
    expect(run.code).toBe(1);
    expect(all(run)).toContain('Could not start the application');
    expect(all(run)).not.toContain(COPIES);
    expect(all(run)).not.toContain(COPY);
  });

  it('indents the lines after the first of a finding, so that no text passes for a line of the report', () => {
    const text = all(marmeon(appWithCopy('throws', true, false, 'ui\nforged line'), ['unknown']));
    expect(text).toContain(COPIES);
    expect(text).toContain('  ui\n    forged line resolves another copy of @marmeon/redis');
    expect(text).not.toMatch(/\nforged line/);
  });

  it('is a warning of doctor that leaves the exit code at 0', () => {
    const { code, stdout } = marmeon(appWithCopy('fails', true), ['doctor', '--only=packages', '--json'], {}, 60_000);
    expect(code).toBe(0);
    const report = JSON.parse(stdout).checks[0];
    expect(report).toMatchObject({ name: 'packages', status: 'warning' });
    expect(report.problems).toEqual([expect.objectContaining({ severity: 'warning', message: COPY })]);
  });

  it('prints nothing about copies after a command that failed later', () => {
    const { code, stderr } = marmeon(appWithCopy('fails', true), ['fails']);
    expect(code).toBe(1);
    expect(stderr).toContain('the command fails');
    expect(stderr).not.toContain('another copy');
  });

  it('prints nothing about copies after a start that failed without one', () => {
    const { code, stdout, stderr } = marmeon(appWithCopy('throws', false), ['unknown']);
    expect(code).toBe(1);
    expect(stderr + stdout).toContain('Could not start the application');
    expect(stderr + stdout).not.toContain(COPIES);
  });

  it('is a warning of check that leaves the exit code at 0', () => {
    const { code, stdout } = marmeon(appWithCopy('fails', true), ['check', '--only=packages', '--json'], {}, 30_000);
    expect(code).toBe(0);
    const report = JSON.parse(stdout).checks[0];
    expect(report).toMatchObject({ name: 'packages', status: 'warning' });
    expect(report.problems).toEqual([expect.objectContaining({ severity: 'warning', message: COPY })]);
  });
});
