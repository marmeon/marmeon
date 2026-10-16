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
