import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';

describe('NODE_ENV from the app’s .env', { timeout: 30_000 }, () => {
  let app: string;
  const blank = join(repo, 'apps/blank-app');
  const config = (dir: string) => `APP_NAME=Blank\nAPP_URL=http://localhost\nAPP_KEY=base64:${Buffer.alloc(32, 5).toString('base64')}\nDB_DATABASE=${join(dir, 'db.sqlite')}\nMAIL_MAILER=array\n`;
  const inApp = (args: string[], env: Record<string, string> = {}) => marmeon(app, args, { NODE_ENV: '', ...env });

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-dotenv-')));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('a developer migrates without --force: NODE_ENV=development from .env, table types written, the worker warns', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    rmSync(join(app, 'bootstrap/database.d.ts'), { force: true });
    const migrate = inApp(['migrate']);
    expect(migrate.stdout).toContain('Environment: development (APP_ENV=local, NODE_ENV from .env)\n');
    expect(migrate.stdout).toContain('Wrote bootstrap/database.d.ts');
    expect(migrate.code).toBe(0);
    expect(existsSync(join(app, 'bootstrap/database.d.ts'))).toBe(true);
    // A production command as development because of .env: said, not refused.
    const worker = inApp(['queue:work', '--stop-when-empty']);
    expect(worker.code).toBe(0);
    expect(`${worker.stdout}${worker.stderr}`).toContain('NODE_ENV=development comes from .env, not from the environment: marmeon queue:work runs with the development tools');
    expect(worker.stdout).toContain('— in development (APP_ENV=local, NODE_ENV from .env)');
  }, 30_000);

  it('the process NODE_ENV wins over .env', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    const production = inApp(['migrate'], { NODE_ENV: 'production' });
    expect(production.code).toBe(1);
    expect(production.stdout).toContain('Environment: production (APP_ENV=production)\n');
    expect(production.stderr).toContain('Pass --force to migrate');
  }, 30_000);

  it('ignores NODE_ENV in .env.{NODE_ENV} — and without NODE_ENV anywhere the app is protected', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=production\nAPP_ENV=qa\n${config(app)}`);
    writeFileSync(join(app, '.env.production'), 'NODE_ENV=development\nAPP_ENV=staging\n');
    try {
      const staging = inApp(['migrate']);
      expect(staging.stderr).toContain('NODE_ENV in .env.production is ignored: .env.production is chosen by NODE_ENV and cannot set it');
      // APP_ENV as the configuration layers it: .env.production over .env.
      expect(staging.stdout).toContain('Environment: production (APP_ENV=staging, NODE_ENV from .env)\n');
      expect(staging.code).toBe(1);
    } finally {
      rmSync(join(app, '.env.production'));
    }
    writeFileSync(join(app, '.env'), config(app));
    const unset = inApp(['migrate']);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('The application is protected (production (APP_ENV=production, NODE_ENV unset)). Pass --force to migrate');
  }, 30_000);
});
