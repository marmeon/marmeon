import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('marmeon modules:check (unlisted jobs and notifications)', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithFiles(files: Record<string, string>): string {
    const app = realpathSync(tempDir('marmeon-unlisted-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), source);
    }
    return app;
  }

  it('warns about a hand-written job no module lists, and exits 0', () => {
    const app = appWithFiles({ 'modules/system/jobs/SendJob.ts': "export class SendJob {\n  static readonly job = 'system.send';\n}\n" });
    const { code, stderr } = marmeon(app, ['modules:check']);
    expect(code).toBe(0);
    expect(stderr).toContain("SendJob (static job 'system.send') is in no module's jobs");
  });

  it('stays quiet about generated jobs and notifications, which make:* registers, and warns when --no-register skips it', () => {
    const app = appWithFiles({});
    expect(marmeon(app, ['make:job', 'Send', '--module=system']).code).toBe(0);
    expect(marmeon(app, ['make:notification', 'Late', '--module=system']).code).toBe(0);
    const registered = marmeon(app, ['modules:check']);
    expect(registered.code).toBe(0);
    expect(registered.stderr).not.toContain('is in no module');
    expect(marmeon(app, ['make:job', 'Skipped', '--module=system', '--no-register']).code).toBe(0);
    expect(marmeon(app, ['modules:check']).stderr).toContain("(static job 'system.skipped') is in no module's jobs");
  });

  it('stays quiet without such a class, and stays out of `marmeon list`', () => {
    const app = appWithFiles({});
    const check = marmeon(app, ['modules:check']);
    expect(check.code).toBe(0);
    expect(check.stderr).not.toContain('is in no module');
    expect(marmeon(app, ['list']).stdout).not.toContain('modules:check');
  });
});
