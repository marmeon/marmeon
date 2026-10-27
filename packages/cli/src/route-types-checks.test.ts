import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { bin, marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('marmeon route:types (reserved page names)', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWith(views: string[]): string {
    const app = realpathSync(tempDir('marmeon-views-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const view of views) {
      mkdirSync(dirname(join(app, view)), { recursive: true });
      writeFileSync(join(app, view), 'export default function Page() { return null; }\n');
    }
    return app;
  }

  it('fails and names every page file whose path has "::"', () => {
    const app = appWith(['modules/a/views/x::y.tsx', 'modules/a/views/p::q/Show.tsx', 'modules/a/views/Fine.tsx']);
    const { code, stderr } = marmeon(app, ['route:types']);
    expect(code).toBe(1);
    expect(stderr).toContain('modules/a/views/x::y.tsx: "::" is reserved for the pages of packages (package::Page) — rename the file or its folder.');
    expect(stderr).toContain('modules/a/views/p::q/Show.tsx: "::" is reserved');
    expect(stderr).not.toContain('Fine.tsx');
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).not.toContain('::'); // left as it was
  });

  it('stops marmeon build on a page path with "::"', () => {
    const app = appWith(['modules/a/views/x::y.tsx']);
    const { code, stderr } = marmeon(app, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('"::" is reserved');
    expect(stderr).toContain('Not built: marmeon route:types failed');
    expect(existsSync(join(app, 'dist'))).toBe(false);
  });

  it('lists the pages of the app’s modules when none has "::"', () => {
    const app = appWith(['modules/a/views/Fine.tsx']);
    expect(marmeon(app, ['route:types']).code).toBe(0);
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).toContain("'a/Fine': true;");
  });
});

describe('marmeon route:types (pages of the framework in their former place)', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWith(views: string[]): string {
    const app = realpathSync(tempDir('marmeon-former-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const view of views) {
      mkdirSync(dirname(join(app, view)), { recursive: true });
      writeFileSync(join(app, view), 'export default function Page() { return null; }\n');
    }
    return app;
  }

  it('stops with K14, names the new path and writes nothing', () => {
    const app = appWith(['modules/errors/views/404.tsx', 'modules/layers/views/Backdrop.tsx']);
    const before = readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8');
    for (const args of [['route:types'], ['route:types', '--check']]) {
      const { code, stderr } = marmeon(app, args);
      expect(code).toBe(1);
      expect(stderr).toContain('K14');
      expect(stderr).toContain('modules/errors/views/404.tsx is no page of the framework any more: move it to modules/system/views/errors/404.tsx');
      expect(stderr).toContain('move it to modules/system/views/layers/Backdrop.tsx');
    }
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).toBe(before);
  });

  it('stops marmeon build', () => {
    const app = appWith(['modules/errors/views/Error.tsx']);
    const { code, stderr } = marmeon(app, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('K14');
    expect(stderr).toContain('Not built: marmeon route:types failed');
    expect(existsSync(join(app, 'dist'))).toBe(false);
  });

  it('stops the server of marmeon dev before it starts', () => {
    const app = appWith(['modules/layers/views/Backdrop.tsx']);
    const { code, stderr } = marmeon(app, ['serve'], { DB_DATABASE: ':memory:', NODE_ENV: 'development', APP_KEY: generateKey(), APP_NAME: 'Former', APP_URL: 'https://example.test', PORT: '0', MARMEON_CHILD: '1', MARMEON_LAUNCH: 'dev' }, 15_000);
    expect(code).toBe(1);
    expect(stderr).toContain('K14');
    expect(stderr).toContain('modules/system/views/layers/Backdrop.tsx');
  });

  it('shows in marmeon check as a problem with its code', () => {
    const app = appWith(['modules/errors/views/500.tsx']);
    marmeon(app, ['route:types']);
    const { code, stdout } = marmeon(app, ['check', '--only=route-types', '--json'], {}, 60_000);
    expect(code).toBe(1);
    const problem = JSON.parse(stdout).checks.flatMap((report: { problems?: { code?: string; message: string }[] }) => report.problems ?? []).find((found: { code?: string }) => found.code === 'K14');
    expect(problem.message).toContain('modules/system/views/errors/500.tsx');
  });

  it('lets other pages of a module named errors through, and the new places', () => {
    const app = appWith(['modules/errors/views/List.tsx', 'modules/system/views/errors/404.tsx']);
    expect(marmeon(app, ['route:types']).code).toBe(0);
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).toContain("'errors/List': true;");
  });
});

describe('marmeon route:types (format mark)', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');
  const MARK = '// @marmeon-format 1';
  // `database.d.ts` is of format 2, `routes.ts` of format 1.
  const DB_MARK = '// @marmeon-format 2';
  const NEWER_DB_MARK = '// @marmeon-format 3';
  const FOREIGN = 'bootstrap/routes.ts was generated by another version of Marmeon — run marmeon route:types and commit it';

  function app(): string {
    const dir = realpathSync(tempDir('marmeon-mark-'));
    cpSync(blank, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(dir, 'node_modules'), 'dir');
    mkdirSync(join(dir, 'storage'));
    return dir;
  }

  it('writes the mark as the third line, and --check passes on the same mark and the same routes', () => {
    const dir = app();
    expect(marmeon(dir, ['route:types']).code).toBe(0);
    expect(readFileSync(join(dir, 'bootstrap/routes.ts'), 'utf8').split('\n')[2]).toBe(MARK);
    expect(marmeon(dir, ['route:types', '--check']).code).toBe(0);
  });

  it('answers a file without the mark with its own message, not "out of date"', () => {
    const dir = app();
    marmeon(dir, ['route:types']);
    const file = join(dir, 'bootstrap/routes.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`${MARK}\n`, ''));
    const { code, stderr } = marmeon(dir, ['route:types', '--check']);
    expect(code).toBe(1);
    expect(stderr).toContain(`[marmeon:H2] ${FOREIGN}`);
    expect(stderr).not.toContain('out of date');
  });

  it('answers an older format number with its own message', () => {
    const dir = app();
    marmeon(dir, ['route:types']);
    const file = join(dir, 'bootstrap/routes.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace(MARK, '// @marmeon-format 0'));
    const { code, stderr } = marmeon(dir, ['route:types', '--check']);
    expect(code).toBe(1);
    expect(stderr).toContain(`[marmeon:H2] ${FOREIGN}`);
  });

  it('answers a newer format number with the newer message and writes nothing over it', () => {
    const dir = app();
    marmeon(dir, ['route:types']);
    const file = join(dir, 'bootstrap/routes.ts');
    const newer = readFileSync(file, 'utf8').replace(MARK, '// @marmeon-format 2');
    writeFileSync(file, newer);
    const check = marmeon(dir, ['route:types', '--check']);
    expect(check.code).toBe(1);
    expect(check.stderr).toMatch(/\[marmeon:H2\] .*generated by a newer version of Marmeon — update @marmeon\/\*/);
    expect(marmeon(dir, ['route:types']).code).not.toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('db:types --check answers a missing mark with the other-version message, a newer one with the newer message', () => {
    const dir = app();
    const file = join(dir, 'bootstrap/database.d.ts');
    const env = { DB_DATABASE: ':memory:' };
    expect(marmeon(dir, ['db:types'], env).code).toBe(0);
    const written = readFileSync(file, 'utf8');
    expect(written.split('\n')[2]).toBe(DB_MARK);
    writeFileSync(file, written.replace(`${DB_MARK}\n`, ''));
    const other = marmeon(dir, ['db:types', '--check'], env);
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/\[marmeon:D7\] .*generated by another version of Marmeon/);
    const newer = written.replace(DB_MARK, NEWER_DB_MARK);
    writeFileSync(file, newer);
    const check = marmeon(dir, ['db:types', '--check'], env);
    expect(check.code).toBe(1);
    expect(check.stderr).toMatch(/\[marmeon:D7\] .*generated by a newer version of Marmeon — update @marmeon\/\*/);
    expect(marmeon(dir, ['db:types'], env).code).not.toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('stops marmeon migrate in development before any migration runs when database.d.ts is of a newer format', () => {
    const dir = app();
    const file = join(dir, 'bootstrap/database.d.ts');
    const env = { DB_DATABASE: ':memory:', NODE_ENV: 'development', APP_KEY: generateKey(), APP_NAME: 'Mark', APP_URL: 'https://example.test' };
    marmeon(dir, ['db:types'], env);
    const newer = readFileSync(file, 'utf8').replace(DB_MARK, NEWER_DB_MARK);
    writeFileSync(file, newer);
    for (const command of ['migrate', 'migrate:fresh']) {
      const { code, stdout, stderr } = marmeon(dir, [command, '--force'], env);
      expect(code).toBe(1);
      expect(stderr).toMatch(/\[marmeon:D7\] .*generated by a newer version of Marmeon — update @marmeon\/\*/);
      expect(stdout).not.toContain('Migrated');
      expect(stdout).not.toContain('Dropped');
    }
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('stops migrate:fresh before it drops a table when database.d.ts is of a newer format', () => {
    const dir = app();
    const database = join(dir, 'storage/fresh.sqlite');
    const env = { DB_DATABASE: database, NODE_ENV: 'development', APP_KEY: generateKey(), APP_NAME: 'Mark', APP_URL: 'https://example.test' };
    expect(marmeon(dir, ['migrate', '--force', '--no-types'], env).code).toBe(0);
    const before = readFileSync(database);
    const file = join(dir, 'bootstrap/database.d.ts');
    marmeon(dir, ['db:types'], env);
    writeFileSync(file, readFileSync(file, 'utf8').replace(DB_MARK, NEWER_DB_MARK));
    const { code, stdout } = marmeon(dir, ['migrate:fresh', '--force'], env);
    expect(code).toBe(1);
    expect(stdout).not.toContain('Dropped');
    expect(readFileSync(database).equals(before)).toBe(true);
  });

  it('keeps "out of date" for a file of this format whose routes changed', () => {
    const dir = app();
    marmeon(dir, ['route:types']);
    const file = join(dir, 'bootstrap/routes.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('interface Routes {}', "interface Routes { 'x.y': { method: 'get'; path: '/x' } }"));
    const { code, stderr } = marmeon(dir, ['route:types', '--check']);
    expect(code).toBe(1);
    expect(stderr).toContain('is out of date');
  });
});

describe('marmeon route:types (access problems)', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithRoute(source: string): string {
    const app = realpathSync(tempDir('marmeon-route-access'));
    cpSync(blank, app, { recursive: true, filter: (path) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(path.slice(blank.length)) && !/[/\\]\.env$/.test(path) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    mkdirSync(join(app, 'modules/pages'));
    writeFileSync(join(app, 'modules/pages/index.ts'), "import { defineModule } from '@marmeon/core';\nimport routes from './routes.ts';\n\nexport default defineModule({ name: 'pages', routes });\n");
    writeFileSync(join(app, 'modules/pages/routes.ts'), source);
    const bootstrap = readFileSync(join(app, 'bootstrap/app.ts'), 'utf8');
    writeFileSync(join(app, 'bootstrap/app.ts'), bootstrap.replace("import system from", "import pages from '../modules/pages/index.ts';\nimport system from").replace('modules: [system]', 'modules: [system, pages]'));
    return app;
  }

  const undecided = "import { defineRoutes } from '@marmeon/http';\n\nexport default defineRoutes((Route) => {\n  Route.get('/about', () => 'about').name('about');\n});\n";

  it('fails on a route that does not say who may call it, after writing the file, and names the route and where it is', () => {
    const app = appWithRoute(undecided);
    const { code, stderr } = marmeon(app, ['route:types']);
    expect(code).toBe(1);
    expect(stderr).toContain('GET  /about  about  Closure  modules/pages/routes.ts:4');
    expect(stderr).toContain('docs/authorization.md#every-route-decides');
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).toContain("'about'");
  });

  it('shows the route’s path without a secret in it', () => {
    const secret = 'k3JdP9xQw2LmZ8vTn5RbY7uHc1AeF4sG';
    const app = appWithRoute(undecided.replace("'/about'", `'/hooks/${secret}'`).replace(".name('about')", ''));
    const { code, stderr } = marmeon(app, ['route:types']);
    expect(code).toBe(1);
    expect(stderr).toContain('/hooks/');
    expect(stderr).not.toContain(secret);
  });

  it('fails route:types --check on it, even when the committed file is current', () => {
    const app = appWithRoute(undecided);
    marmeon(app, ['route:types']);
    const { code, stderr } = marmeon(app, ['route:types', '--check']);
    expect(code).toBe(1);
    expect(stderr).toContain('/about');
  });

  it('refuses marmeon start --workers=2 once, in the primary, before any worker is forked', () => {
    const app = appWithRoute(undecided);
    const { MARMEON_CHILD: _child, NODE_ENV: _env, ...parent } = process.env;
    const result = spawnSync(process.execPath, [bin, 'start', '--workers=2'], {
      cwd: app,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...parent, APP_KEY: generateKey(), APP_NAME: 'Access', APP_URL: 'https://example.test', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production', NO_COLOR: '1' },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output.split('does not say who may call it').length - 1).toBe(1);
    expect(output).not.toContain('Starting 2 workers');
  });

  it('passes once the route says everyone may call it', () => {
    const app = appWithRoute(undecided.replace("import { defineRoutes }", "import { defineRoutes, everyone }").replace('defineRoutes((Route) => {', 'defineRoutes((Root) => {\n  const Route = Root.authorize(everyone);'));
    expect(marmeon(app, ['route:types']).code).toBe(0);
  });

  it('stops marmeon build', () => {
    const app = appWithRoute(undecided);
    const { code, stderr } = marmeon(app, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('Not built: marmeon route:types failed');
    expect(existsSync(join(app, 'dist'))).toBe(false);
  });
});
