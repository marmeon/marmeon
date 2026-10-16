import { cpSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('marmeon: two commands with one name', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithCommand(name: string): string {
    const app = realpathSync(tempDir('marmeon-names-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(
      join(app, 'modules/system/Ours.ts'),
      `export class OursCommand {\n  static command = '${name}';\n  static description = 'Ours';\n  handle() {\n    console.log('OURS RAN');\n  }\n}\n`,
    );
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { OursCommand } from './Ours.ts';\nexport default defineModule({ name: 'system', commands: [OursCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    return app;
  }

  it('fails the start instead of running either command', () => {
    const app = appWithCommand('route:list');
    for (const args of [['route:list'], ['list']]) {
      const { code, stdout, stderr } = marmeon(app, args);
      expect(code).toBe(1);
      expect(stderr).toContain('Two commands are named "route:list": RouteListCommand (marmeon) and OursCommand (module system)');
      expect(stdout).not.toContain('OURS RAN');
    }
  });

  it('fails the start when a module reuses the name of a package command', () => {
    const app = appWithCommand('db:seed');
    for (const args of [['list'], ['db:seed']]) {
      const { code, stdout, stderr } = marmeon(app, args);
      expect(code).toBe(1);
      expect(stderr).toContain('Two commands are named "db:seed"');
      expect(stderr).toContain('DbSeedCommand (DatabaseServiceProvider)');
      expect(stdout).not.toContain('OURS RAN');
    }
  });

  it('stops a command that only registers the app, before anything boots', () => {
    const app = appWithCommand('db:seed');
    const { code, stdout, stderr } = marmeon(app, ['route:types']);
    expect(code).toBe(1);
    expect(stderr).toContain('Two commands are named "db:seed"');
    expect(stdout).not.toContain('OURS RAN');
  });

  it('stops marmeon build before anything is built', () => {
    const app = appWithCommand('db:seed');
    const { code, stderr } = marmeon(app, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('Two commands are named "db:seed"');
    expect(stderr).toContain('Not built: marmeon route:types failed');
    expect(existsSync(join(app, 'dist'))).toBe(false);
  });

  it('stops marmeon build when a module reuses the name build', () => {
    const app = appWithCommand('build');
    const { code, stderr } = marmeon(app, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('BuildCommand (marmeon)');
    expect(stderr).toContain('Not built:');
    expect(existsSync(join(app, 'dist'))).toBe(false);
  });

  it('starts when the names differ', () => {
    const app = appWithCommand('ours:run');
    const { code, stdout } = marmeon(app, ['ours:run']);
    expect(code).toBe(0);
    expect(stdout).toContain('OURS RAN');
  });
});
