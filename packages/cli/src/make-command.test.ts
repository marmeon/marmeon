import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('marmeon make:command (checks every registered command)', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithFiles(files: Record<string, string>): string {
    const app = realpathSync(tempDir('marmeon-make-command-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), source);
    }
    return app;
  }

  const authModule = { 'modules/auth/index.ts': "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'auth' });\n" };

  it('refuses the name of an installed package command and writes nothing', () => {
    const app = appWithFiles(authModule);
    const { code, stderr } = marmeon(app, ['make:command', 'PruneTokens', '--module=auth']);
    expect(code).toBe(1);
    expect(stderr).toContain('auth:prune-tokens is already the name of PruneTokensCommand (AuthServiceProvider)');
    expect(existsSync(join(app, 'modules/auth/commands'))).toBe(false);
  });

  it('writes a free name without a .env and lists it', () => {
    const app = appWithFiles(authModule);
    const { code } = marmeon(app, ['make:command', 'RotateKeys', '--module=auth']);
    expect(code).toBe(0);
    expect(existsSync(join(app, 'modules/auth/commands/RotateKeysCommand.ts'))).toBe(true);
    expect(readFileSync(join(app, 'modules/auth/index.ts'), 'utf8')).toContain('commands: [RotateKeysCommand]');
  });

  it('stops with the load error instead of falling back, and writes nothing', () => {
    const app = appWithFiles({ 'modules/system/index.ts': "export default (() => {\n  throw new Error('broken');\n})();\n" });
    const { code, stderr } = marmeon(app, ['make:command', 'X', '--module=system']);
    expect(code).toBe(1);
    expect(stderr).toContain('Could not start the application: broken');
    expect(existsSync(join(app, 'modules/system/commands'))).toBe(false);
  });

  it('stops on a name that is already used twice', () => {
    const app = appWithFiles({
      'modules/system/Ours.ts': "export class OursCommand {\n  static command = 'db:seed';\n  static description = 'Ours';\n  handle() {}\n}\n",
      'modules/system/index.ts':
        "import { defineModule } from '@marmeon/core';\nimport { OursCommand } from './Ours.ts';\nexport default defineModule({ name: 'system', commands: [OursCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    });
    const { code, stderr } = marmeon(app, ['make:command', 'X', '--module=system']);
    expect(code).toBe(1);
    expect(stderr).toContain('Two commands are named "db:seed"');
    expect(existsSync(join(app, 'modules/system/commands'))).toBe(false);
  });

  it('prints its help without loading the app', () => {
    const app = appWithFiles({ 'modules/system/index.ts': "export default (() => {\n  throw new Error('broken');\n})();\n" });
    const { code, stdout } = marmeon(app, ['make:command', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('make:command');
  });
});
