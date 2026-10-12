import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * A minimal app outside the workspace: no UI adapter (the plugin is UI-agnostic), and one framework
 * package whose `@marmeon/source` condition points at different code than its build.
 */
function app({ vite = true, plugin = true, typescript, files = {} }: { vite?: boolean; plugin?: boolean; typescript?: string; files?: Record<string, string> } = {}): string {
  const root = tempDir('marmeon-vite-');
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@marmeon/fake': '*' } }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    'bootstrap/client.ts': [
      "import { origin } from '@marmeon/fake';",
      "import pages from 'virtual:marmeon/pages';",
      "if (import.meta.env.DEV) console.log('development only');",
      'document.title = `${origin} ${Object.keys(pages).join(",")}`;',
      "for (const load of Object.values(pages)) void load();",
    ].join('\n'),
    'bootstrap/ssr.ts': "import { origin } from '@marmeon/fake';\nexport const render = async () => ({ html: origin });\n",
    'modules/demo/views/Home.ts': "export default 'home page';\n",
    'node_modules/@marmeon/fake/package.json': JSON.stringify({
      name: '@marmeon/fake',
      type: 'module',
      exports: { '.': { '@marmeon/source': './src/index.js', default: './dist/index.js' } },
    }),
    'node_modules/@marmeon/fake/src/index.js': "export const origin = 'from-src';\n",
    'node_modules/@marmeon/fake/dist/index.js': "export const origin = 'from-dist';\n",
    'vite.config.ts': plugin
      ? [
          "import { marmeon } from '@marmeon/vite';",
          "export default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, pages: 'modules/*/views/**/*.ts' })] };",
        ].join('\n')
      : 'export default {};',
  });
  write(root, files);
  if (vite) {
    symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
    symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@marmeon/vite'), 'dir');
  }
  if (typescript !== undefined) {
    // An app with its own TypeScript: `marmeon build` type-checks `modules/` first.
    symlinkSync(realpathSync(join(repo, 'node_modules/typescript')), join(root, 'node_modules/typescript'), 'dir');
    write(root, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'nodenext', types: [] }, include: ['modules/**/*.ts'] }),
      'modules/demo/total.ts': typescript,
    });
  }
  return root;
}

/** `marmeon build` as an app runs it: a fresh process, no test environment. */
function build(root: string, ...args: string[]): { code: number | null; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
  const result = spawnSync(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), 'build', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const bundle = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');

describe('marmeon build with the marmeon() plugin', () => {
  it('never resolves the source condition, builds for production, and writes both bundles where the server looks', async () => {
    const root = app();
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);

    const client = bundle(join(root, 'dist/client'));
    const server = bundle(join(root, 'dist/server'));
    // The source condition is for serving inside the monorepo only: a build takes what a published package ships.
    expect(client).toContain('from-dist');
    expect(`${client}${server}`).not.toContain('from-src');
    expect(`${client}${server}`).not.toMatch(/@marmeon\/fake\/src\//);
    // A production build (`resolveConfig` must not leave NODE_ENV=development behind).
    expect(client).not.toContain('development only');

    // The client entry comes from the plugin, not from index.html.
    // `async`: a streamed page hydrates its shell while the rest still arrives.
    // Every tag carries the nonce placeholder (Vite's `html.cspNonce`) — the server fills in each response's nonce.
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8');
    expect(html).toMatch(/<script type="module" async crossorigin src="\/assets\/index-[\w-]+\.js" nonce="__marmeon_csp_nonce__"><\/script>/);
    expect(html).toContain('<meta property="csp-nonce" nonce="__marmeon_csp_nonce__">');
    // virtual:marmeon/pages: root-absolute keys, one chunk per page.
    expect(client).toContain('/modules/demo/views/Home.ts');
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.startsWith('Home-'))).toBe(true);

    // Vite's manifest sits beside index.html (not in assets/, which a CDN may serve); the server preloads from it.
    const manifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { isEntry?: boolean }>;
    expect(Object.values(manifest).some((chunk) => chunk.isEntry === true)).toBe(true);
    expect(manifest['modules/demo/views/Home.ts']).toBeDefined();
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.includes('manifest'))).toBe(false);

    // The overridden SSR entry still lands at dist/server/ssr.js, and runs as `marmeon start` runs it (no source condition).
    const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `const { render } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server/ssr.js')).href)}); console.log((await render()).html);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(ssr.stdout.trim()).toBe('from-dist');
  }, 60_000);

  it('loads the first page in two chunks — third-party code (vendor) and the rest (index) — and keeps what loads later out of them', () => {
    const root = app({
      files: {
        'bootstrap/client.ts': [
          "import { pad } from 'left-pad';",
          "import { origin } from '@marmeon/fake';",
          "import { shared } from '../modules/demo/shared.ts';",
          "import pages from 'virtual:marmeon/pages';",
          'document.title = pad(`${origin} ${shared}`);',
          'for (const load of Object.values(pages)) void load();',
        ].join('\n'),
        'modules/demo/shared.ts': "export const shared = 'shared-with-a-page';\n",
        // A page (loaded on first use) that shares a module with the first page — without the groups, that module is a chunk of its own.
        'modules/demo/views/Home.ts': "import { shared } from '../shared.ts';\nexport default `home page ${shared}`;\n",
        'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', type: 'module', exports: './index.js' }),
        'node_modules/left-pad/index.js': "export const pad = (text) => `third-party ${text}`;\n",
      },
    });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);
    const assets = join(root, 'dist/client/assets');
    const files = readdirSync(assets).filter((file) => file.endsWith('.js'));
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8');
    const initial = files.filter((file) => html.includes(file));
    expect(initial.map((file) => file.replace(/-[\w-]+\.js$/, '')).sort()).toEqual(['index', 'vendor']);
    const read = (prefix: string) => readFileSync(join(assets, files.find((file) => file.startsWith(`${prefix}-`))!), 'utf8');
    expect(read('vendor')).toContain('third-party');
    expect(read('vendor')).not.toContain('from-dist');
    expect(read('index')).toContain('from-dist');
    expect(read('index')).toContain('shared-with-a-page');
    // The page stays a chunk of its own, loaded on first use.
    expect(read('index')).not.toContain('home page');
    expect(read('Home')).toContain('home page');
    expect(files.filter((file) => !/^(index|vendor|Home|rolldown-runtime)-/.test(file))).toEqual([]);
  }, 60_000);

  it('type-checks the app first, like next build: a type error fails the build and is printed; --no-typecheck builds anyway', () => {
    const root = app({ typescript: "export const total: number = 'forty-two';\n" });
    const failed = build(root);
    expect(failed.out).toContain("modules/demo/total.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(failed.out).toContain('Not built: 1 type error in 1 file (tsc --noEmit). Fix them — or build anyway with --no-typecheck.');
    expect(failed.out).not.toContain('Built dist/client');
    expect(failed.code).toBe(1);

    const skipped = build(root, '--no-typecheck');
    expect(skipped.out).toContain('Built dist/client and dist/server');
    expect(skipped.code).toBe(0);

    writeFileSync(join(root, 'modules/demo/total.ts'), 'export const total: number = 42;\n');
    const passed = build(root);
    expect(passed.out).toContain('✓ Type-checked the app');
    expect(passed.code).toBe(0);
  }, 60_000);

  it('says how to install Vite when the app has none', () => {
    const { code, out } = build(app({ vite: false }));
    expect(out).toContain('Vite is not installed in this app. `marmeon dev` and `marmeon build` need it: pnpm add -D vite@^8 @marmeon/vite');
    expect(code).toBe(1);
  });

  it('says how to install @marmeon/vite when the config imports it but the app lacks it — not a module error', () => {
    const root = app();
    rmSync(join(root, 'node_modules/@marmeon/vite'));
    const { code, out } = build(root);
    expect(out).toContain('vite.config.ts imports @marmeon/vite, which is not installed in this app: pnpm add -D vite@^8 @marmeon/vite');
    expect(out).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(code).toBe(1);
  });

  it('asks for the marmeon() plugin when vite.config.ts does not use it', () => {
    const { code, out } = build(app({ plugin: false }));
    expect(out).toContain('vite.config.ts does not use the marmeon() plugin');
    expect(out).toContain('plugins: [marmeon(), react()]');
    expect(code).toBe(1);
  });
});

/**
 * The browser's route manifest: `.marmeon/routes.json` as `marmeon route:types` writes it — a fake adapter
 * stands in for @marmeon/react, so the collector finds its sinks without a UI framework.
 */
function routesApp(client: string): string {
  return app({
    files: {
      '.marmeon/routes.json': JSON.stringify({
        version: 1,
        routes: {
          home: { method: 'get', path: '/home-path' },
          'profile.update': { method: 'put', path: '/profile-path/:user' },
          'profile.show': { method: 'get', path: '/profile-path/:user/show' },
          // Only a controller redirects here (`redirect().route('admin.secret')`): no client code names it.
          'admin.secret': { method: 'get', path: '/admin/secret-path' },
        },
        hidden: { 'verify.link': 'internal', 'api.users': 'api' },
      }),
      'node_modules/@marmeon/react/package.json': JSON.stringify({ name: '@marmeon/react', type: 'module', exports: './index.js' }),
      'node_modules/@marmeon/react/index.js':
        'export const useRoute = (routes) => (name) => routes[name].path;\nexport const useForm = (name, params, initial) => ({ name, params, initial });\n',
      'bootstrap/client.ts': [
        "import { useForm, useRoute } from '@marmeon/react';",
        "import { routes } from 'virtual:marmeon/routes';",
        'const route = useRoute(routes);',
        client,
      ].join('\n'),
      'bootstrap/ssr.ts': "import { routes } from 'virtual:marmeon/routes';\nexport const render = async () => ({ html: JSON.stringify(routes) });\n",
    },
  });
}

describe('virtual:marmeon/routes in a build', () => {
  it('ships only the route names client code writes out; the SSR bundle has every route the browser may learn', () => {
    const root = routesApp("document.title = route('home');\nconsole.log(useForm('profile.update', { user: 1 }, {}));\n");
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);

    const client = bundle(join(root, 'dist/client'));
    expect(client).toMatch(/[`"']home[`"']/);
    expect(client).toContain('/home-path');
    expect(client).toMatch(/[`"']profile\.update[`"']/);
    // The route only the server links to: neither its name nor its pattern reaches the browser.
    expect(client).not.toContain('admin.secret');
    expect(client).not.toContain('/admin/secret-path');
    expect(client).not.toContain('profile.show');
    expect(client).not.toContain('verify.link');
    expect(client).not.toContain('__MARMEON_ROUTE_MANIFEST__');

    const server = bundle(join(root, 'dist/server'));
    expect(server).toContain('admin.secret');
    expect(server).not.toContain('verify.link');
    expect(server).not.toContain('api.users');
  }, 60_000);

  it('fails the build for an .internal() route named in client code', () => {
    const { code, out } = build(routesApp("document.title = route('verify.link');\n"));
    expect(out).toContain(
      "[marmeon] bootstrap/client.ts:4:24 — 'verify.link' is never sent to the browser — it is .internal(). Link to it from the server (redirect().route(), router.url()), not from client code.",
    );
    expect(out).toContain("✗ Not built: 1 route name the browser's route manifest cannot be built from.");
    expect(out).not.toContain('RolldownError'); // a message, not a stack trace
    expect(out).not.toContain('Built dist/client');
    expect(code).toBe(1);
  }, 60_000);

  it('fails the build for a name built at runtime, naming the routes it could have meant', () => {
    const { code, out } = build(routesApp('const tab = location.hash.slice(1);\ndocument.title = route(`profile.${tab}`, { user: 1 });\n'));
    expect(out).toContain(
      '[marmeon] bootstrap/client.ts:5:24 — route names sent to the browser must be written out: `profile.${tab}` (route()) is built at runtime, so the build ' +
        "cannot tell which routes this page needs. Did you mean one of profile.show, profile.update? Write them as literals, e.g. tab === 'show' ? 'profile.show' : 'profile.update'.",
    );
    expect(out).not.toContain('Built dist/client');
    expect(code).toBe(1);
  }, 60_000);
});

/** An app with a controller that imports nothing: without the check, a value import would build green and ship it. */
function serverCodeApp(files: Record<string, string>): string {
  return app({
    files: {
      'modules/demo/controllers/ShowHomeController.ts': "export class ShowHomeController {\n  handle() {\n    return 'server-only-secret';\n  }\n}\n",
      'bootstrap/ssr.ts': "import { ShowHomeController } from '../modules/demo/controllers/ShowHomeController.ts';\nexport const render = async () => ({ html: new ShowHomeController().handle() });\n",
      ...files,
    },
  });
}

describe('server imports in a build', () => {
  it('fails the build for a page that imports a controller as a value — file, line and the fix, no stack', () => {
    const root = serverCodeApp({ 'modules/demo/views/Home.ts': "import { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport default (page: ShowHomeController) => page;\n" });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain(
      "[marmeon] modules/demo/views/Home.ts:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value: a controller is server code, and a value import bundles it — with everything it imports — into the browser. A class is a value even where only its type is used: write import type { ShowHomeController } from '../controllers/ShowHomeController.ts'.",
    );
    expect(out).toContain('✗ Not built: 1 import brings server code into the browser.');
    expect(out).not.toContain('RolldownError');
    expect(out).not.toContain('Built dist/client');
    expect(code).toBe(1);
  }, 60_000);

  it('fails it for an indirect import too (page → helper → controller), naming the helper and the chain', () => {
    const root = serverCodeApp({
      'modules/demo/helpers.ts': "import { ShowHomeController } from './controllers/ShowHomeController.ts';\nexport const label = () => ShowHomeController.name;\n",
      'modules/demo/views/Home.ts': "import { label } from '../helpers.ts';\nexport default label();\n",
    });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain(
      '[marmeon] modules/demo/helpers.ts:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value (modules/demo/helpers.ts is client code: modules/demo/views/Home.ts → modules/demo/helpers.ts): a controller is server code',
    );
    expect(code).toBe(1);
  }, 60_000);

  it('builds a page that imports the controller with import type or re-exports its type — the controller stays on the server, where SSR may import it', () => {
    const root = serverCodeApp({
      'modules/demo/views/Home.ts': "import type { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport type { ShowHomeController as Page } from '../controllers/ShowHomeController.ts';\nexport default (page?: ShowHomeController) => `home page ${typeof page}`;\n",
    });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);
    expect(bundle(join(root, 'dist/client'))).not.toContain('server-only-secret');
    expect(bundle(join(root, 'dist/server'))).toContain('server-only-secret');
  }, 60_000);
});
