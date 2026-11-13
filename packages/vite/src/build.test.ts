import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { CLIENT_CHUNKS, marmeon } from './plugin.ts';

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
    'modules/demo/views/Home.tsx': "export default 'home page';\n",
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
          "export default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } })] };",
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
  const env: Record<string, string | undefined> = { ...process.env, VITE_FROM_PROCESS: 'process-secret-value' };
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
    expect(client).toContain('/modules/demo/views/Home.tsx');
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.startsWith('Home-'))).toBe(true);

    // Vite's manifest sits beside index.html (not in assets/, which a CDN may serve); the server preloads from it.
    const manifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { isEntry?: boolean }>;
    expect(Object.values(manifest).some((chunk) => chunk.isEntry === true)).toBe(true);
    expect(manifest['modules/demo/views/Home.tsx']).toBeDefined();
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.includes('manifest'))).toBe(false);

    // The overridden SSR entry still lands at dist/server/ssr.js, and runs as `marmeon start` runs it (no source condition).
    const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `const { render } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server/ssr.js')).href)}); console.log((await render()).html);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(ssr.stdout.trim()).toBe('from-dist');
  }, 60_000);

  it('ships no test beside a page — neither to the browser nor in the server bundle', () => {
    const root = app({
      files: {
        'bootstrap/ssr.ts': "import pages from 'virtual:marmeon/pages';\nexport const render = async () => ({ html: Object.keys(pages).join(',') });\n",
        'modules/demo/views/islands/Clock.test.tsx': "export default 'clock test';\n",
        'modules/demo/views/Clock.spec.tsx': "export default 'clock spec';\n",
        'modules/demo/views/Clock.type-test.tsx': "export default 'clock type test';\n",
      },
    });
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);
    const client = bundle(join(root, 'dist/client'));
    const server = bundle(join(root, 'dist/server'));
    expect(client).toContain('/modules/demo/views/Home.tsx');
    expect(server).toContain('/modules/demo/views/Home.tsx');
    expect(`${client}${server}`).not.toContain('Clock');
    expect(`${client}${server}`).not.toMatch(/clock (?:test|spec|type test)/);
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.startsWith('Clock'))).toBe(false);
  }, 60_000);

  it('keeps .env files and VITE_ variables out of the client bundle — unless the app asks with viteEnv', () => {
    const files = (viteEnv: boolean): Record<string, string> => ({
      '.env': 'VITE_SECRET=file-secret-value\n',
      'bootstrap/client.ts': [
        "import pages from 'virtual:marmeon/pages';",
        'document.title = `${import.meta.env.VITE_SECRET} ${import.meta.env.VITE_FROM_PROCESS} mode:${import.meta.env.MODE}:end`;',
        'for (const load of Object.values(pages)) void load();',
      ].join('\n'),
      'vite.config.ts': [
        "import { marmeon } from '@marmeon/vite';",
        `export default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, viteEnv: ${viteEnv} })] };`,
      ].join('\n'),
    });

    const closed = app({ files: files(false) });
    expect(build(closed).code).toBe(0);
    const closedClient = bundle(join(closed, 'dist/client'));
    expect(closedClient).not.toContain('file-secret-value');
    expect(closedClient).not.toContain('process-secret-value');
    expect(closedClient).toContain('mode:production:end'); // MODE stays

    const open = app({ files: files(true) });
    expect(build(open).code).toBe(0);
    const openClient = bundle(join(open, 'dist/client'));
    expect(openClient).toContain('file-secret-value');
    expect(openClient).toContain('process-secret-value');
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
        'modules/demo/views/Home.tsx': "import { shared } from '../shared.ts';\nexport default `home page ${shared}`;\n",
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
    expect(out).toContain('Vite is not installed in this app. `marmeon dev` and `marmeon build` need it: pnpm add -D vite@^8 @marmeon/vite@<version of your app>');
    expect(code).toBe(1);
  });

  it('says how to install @marmeon/vite when the config imports it but the app lacks it — not a module error', () => {
    const root = app();
    rmSync(join(root, 'node_modules/@marmeon/vite'));
    const { code, out } = build(root);
    expect(out).toContain('vite.config.ts imports @marmeon/vite, which is not installed in this app: pnpm add -D vite@^8 @marmeon/vite@<version of your app>');
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
        'export const useRoute = (routes) => (name) => routes[name].path;\nexport const useForm = (name, initial, options) => ({ name, initial, options });\n',
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
    const root = routesApp("document.title = route('home');\nconsole.log(useForm('profile.update', {}, { params: { user: 1 } }));\n");
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

/**
 * An app with a package of compiled ESM in `node_modules` that declares a namespace: a page that names a route, imports a
 * stylesheet and reads the route manifest, as built code of a package does.
 */
function uiPackageApp(): string {
  return app({
    files: {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@marmeon/fake': '*', '@marmeon/react': '*', 'status-board': '*' } }),
      '.marmeon/routes.json': JSON.stringify({
        version: 1,
        routes: { 'status.index': { method: 'get', path: '/status-path' }, 'admin.secret': { method: 'get', path: '/admin/secret-path' } },
        hidden: {},
      }),
      'node_modules/@marmeon/react/package.json': JSON.stringify({ name: '@marmeon/react', type: 'module', exports: './index.js' }),
      'node_modules/@marmeon/react/index.js': 'export const useRoute = (routes) => (name) => routes[name].path;\nexport const Link = () => null;\n',
      'node_modules/react/package.json': JSON.stringify({ name: 'react', type: 'module', exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js' } }),
      'node_modules/react/index.js': 'export {};\n',
      'node_modules/react/jsx-runtime.js': 'export const jsx = (type, props) => ({ type, props });\n',
      'node_modules/status-board/package.json': JSON.stringify({
        name: 'status-board',
        type: 'module',
        exports: { './client': './dist/client.js', './ssr': './dist/ssr.js', './views/*': './dist/views/*.js' },
        marmeon: { namespace: 'status', entry: { client: './client', ssr: './ssr' }, views: './views' },
      }),
      'node_modules/status-board/dist/client.js': 'export {};\n',
      'node_modules/status-board/dist/ssr.js': 'export {};\n',
      'node_modules/status-board/dist/views/Index.js': [
        "import { Link } from '@marmeon/react';",
        "import { jsx } from 'react/jsx-runtime';",
        "import { routes } from 'virtual:marmeon/routes';",
        "import './status.css';",
        // Compiled JSX, as a package ships it: the route name sits in the props of a `jsx()` call.
        "export default () => `status-board:${routes['status.index'].path}:${typeof jsx(Link, { route: 'status.index' })}`;",
      ].join('\n'),
      'node_modules/status-board/dist/views/status.css': '.status-board { color: teal; }\n',
      'bootstrap/client.ts': "import pages from 'virtual:marmeon/pages/status';\nfor (const load of Object.values(pages)) void load();\ndocument.title = Object.keys(pages).join(',');\n",
      'bootstrap/ssr.ts': "import Index from 'status-board/views/Index';\nexport const render = async () => ({ html: Index() });\n",
    },
  });
}

describe('a package that declares a namespace, in a build', () => {
  it('is bundled with the app: its route names reach the browser manifest, and server rendering runs it with no loose import left', () => {
    const root = uiPackageApp();
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);

    const client = bundle(join(root, 'dist/client'));
    expect(client).toContain('status::Index');
    // The name is written out in the package only; the route no code names stays on the server.
    expect(client).toContain('/status-path');
    expect(client).not.toContain('admin.secret');
    expect(readdirSync(join(root, 'dist/client/assets')).some((file) => file.endsWith('.css'))).toBe(true);

    // The server bundle holds the package's page itself (and the stylesheet is no import Node must load): it runs from `dist`.
    expect(bundle(join(root, 'dist/server'))).toContain('status-board:');
    const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `const { render } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server/ssr.js')).href)}); console.log((await render()).html);`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(ssr.stdout.trim()).toBe('status-board:/status-path:object');
  }, 60_000);
});

/**
 * An app and a package with an entry of its own, in one build. Every module carries a marker the tests look for in the chunks an entry loads
 * first: `fake-react` is what both share, `app-lib`/`admin-lib` and `appOnly`/`adminOnly` what only one reaches, `pkgmod` what the package's
 * entry and an app page import, and the package's page imports `appOnly` from the app.
 */
function twoEntryApp(extra: Record<string, string> = {}, aliases: Record<string, string> = {}): string {
  return app({
    files: {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@marmeon/fake': '*', 'status-board': '*', 'fake-react': '*', 'app-lib': '*' } }),
      'vite.config.ts': [
        "import { marmeon } from '@marmeon/vite';",
        "import { writeFileSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        `const alias = Object.fromEntries(Object.entries({ 'app-mod': 'modules/demo/appOnly.ts', ...${JSON.stringify(aliases)} }).map(([name, file]) => [name, fileURLToPath(new URL(\`./\${file}\`, import.meta.url))]));`,
        // Writes what the build made of the client: each chunk's modules and each module's imports, for the tests to check against.
        'const record = { name: "record", generateBundle(_, bundle) { if (this.environment.name !== "client") return; const chunks = {}; const modules = {}; for (const chunk of Object.values(bundle)) { if (chunk.type !== "chunk") continue; chunks[chunk.fileName] = { facade: chunk.facadeModuleId, moduleIds: chunk.moduleIds }; for (const id of chunk.moduleIds) { const info = this.getModuleInfo(id); if (info) modules[id] = { imports: info.importedIds, dynamic: info.dynamicallyImportedIds }; } } writeFileSync(fileURLToPath(new URL("./graph.json", import.meta.url)), JSON.stringify({ chunks, modules })); } };',
        "export default { resolve: { alias }, plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } }), record] };",
      ].join('\n'),
      'node_modules/fake-react/package.json': JSON.stringify({ name: 'fake-react', type: 'module', exports: './index.js' }),
      'node_modules/fake-react/index.js': "export const react = 'REACT_MARK';\n",
      'node_modules/app-lib/package.json': JSON.stringify({ name: 'app-lib', type: 'module', exports: './index.js' }),
      'node_modules/app-lib/index.js': "export const lib = 'APP_LIB_MARK';\n",
      'bootstrap/app.css': '.app-css-mark { color: red; }\n',
      'bootstrap/client.ts': [
        "import { origin } from '@marmeon/fake';",
        "import { react } from 'fake-react';",
        "import { lib } from 'app-lib';",
        "import { appOnly } from '../modules/demo/appOnly.ts';",
        "import pages from 'virtual:marmeon/pages';",
        "import './app.css';",
        'document.title = `${origin} ${react} ${lib} ${appOnly}`;',
        'for (const load of Object.values(pages)) void load();',
      ].join('\n'),
      'modules/demo/appOnly.ts': "export const appOnly = 'APP_ONLY_MARK';\n",
      'modules/demo/views/Home.tsx': "export default 'home page';\n",
      // A page of the app that imports one module of the package's first-load graph.
      'modules/demo/views/A.tsx': "import { pkgmod } from 'status-board/pkgmod';\nexport default `page ${pkgmod}`;\n",
      'node_modules/status-board/package.json': JSON.stringify({
        name: 'status-board',
        type: 'module',
        exports: { './client': './dist/client.js', './ssr': './dist/ssr.js', './pkgmod': './dist/pkgmod.js', './views/*': './dist/views/*.js' },
        marmeon: { namespace: 'status', entry: { client: './client', ssr: './ssr' }, views: './views' },
      }),
      'node_modules/status-board/dist/client.js': [
        "import { origin } from '@marmeon/fake';",
        "import { react } from 'fake-react';",
        "import { lib } from 'admin-lib';",
        "import { adminOnly } from './adminOnly.js';",
        "import { pkgmod } from './pkgmod.js';",
        "import pages from 'virtual:marmeon/pages/status';",
        "import './status.css';",
        'document.title = `${origin} ${react} ${lib} ${adminOnly} ${pkgmod}`;',
        'for (const load of Object.values(pages)) void load();',
      ].join('\n'),
      'node_modules/status-board/dist/ssr.js': "export const render = () => 'status ssr';\n",
      'node_modules/status-board/dist/adminOnly.js': "export const adminOnly = 'ADMIN_ONLY_MARK';\n",
      'node_modules/status-board/dist/pkgmod.js': "export const pkgmod = 'PKGMOD_MARK';\n",
      'node_modules/status-board/dist/status.css': '.admin-css-mark { color: teal; }\n',
      'node_modules/status-board/dist/views/Index.js': "import { appOnly } from 'app-mod';\nexport default `status page ${appOnly}`;\n",
      'node_modules/admin-lib/package.json': JSON.stringify({ name: 'admin-lib', type: 'module', exports: './index.js' }),
      'node_modules/admin-lib/index.js': "export const lib = 'ADMIN_LIB_MARK';\n",
      ...extra,
    },
  });
}

/**
 * The modules an entry loads first that it does not import statically itself (empty is right). The graph comes from the build (`graph.json`,
 * written by the app's test plugin), so modules without a marker count too: the pages module, the entry itself, stylesheets. The first-load
 * set is the entry's chunk and, transitively, the chunks it imports statically; a module belongs when a chain of static imports from the
 * entry leads to it, so code the entry loads lazily never runs first.
 */
function strays(root: string, manifestKey: string, entryId: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string; imports?: string[] }>;
  const graph = JSON.parse(readFileSync(join(root, 'graph.json'), 'utf8')) as { chunks: Record<string, { moduleIds: string[] }>; modules: Record<string, { imports: string[]; dynamic: string[] }> };
  const reached = new Set<string>();
  for (const stack = [entryId]; stack.length > 0; ) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    stack.push(...(graph.modules[id]?.imports ?? []));
  }
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const imported of manifest[key]!.imports ?? []) walk(imported);
  };
  walk(manifestKey);
  const loaded = [...seen].flatMap((key) => graph.chunks[manifest[key]!.file]?.moduleIds ?? []);
  expect(loaded.length).toBeGreaterThan(0);
  return loaded.filter((id) => id in graph.modules && !reached.has(id));
}

/** The module id of a file the way the bundler names it. */
const idOf = (root: string, file: string) => realpathSync.native(join(root, file)).replaceAll('\\', '/');

/** Two packages with an entry besides the app: `m` is reached by the app and the status package, `n`, which `m` imports, by all three. */
function threeEntryApp(): string {
  const dependencies = { '@marmeon/fake': '*', 'status-board': '*', 'report-board': '*', 'fake-react': '*', 'app-lib': '*' };
  return twoEntryApp(
    {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies }),
      'bootstrap/client.ts': [
        "import { m } from 'shared-m';",
        "import { n } from 'shared-n';",
        "import pages from 'virtual:marmeon/pages';",
        'document.title = `APP_MARK ${m} ${n}`;',
        'for (const load of Object.values(pages)) void load();',
      ].join('\n'),
      'modules/demo/m.ts': "import { n } from 'shared-n';\nexport const m = `M_MARK ${n}`;\n",
      'modules/demo/n.ts': "export const n = 'N_MARK';\n",
      'node_modules/status-board/dist/client.js': "import { m } from 'shared-m';\nimport pages from 'virtual:marmeon/pages/status';\ndocument.title = `STATUS_MARK ${m}`;\nfor (const load of Object.values(pages)) void load();\n",
      'node_modules/report-board/package.json': JSON.stringify({
        name: 'report-board',
        type: 'module',
        exports: { './client': './dist/client.js', './ssr': './dist/ssr.js', './views/*': './dist/views/*.js' },
        marmeon: { namespace: 'report', entry: { client: './client', ssr: './ssr' }, views: './views' },
      }),
      'node_modules/report-board/dist/client.js': "import { n } from 'shared-n';\nimport pages from 'virtual:marmeon/pages/report';\ndocument.title = `REPORT_MARK ${n}`;\nfor (const load of Object.values(pages)) void load();\n",
      'node_modules/report-board/dist/ssr.js': "export const render = () => 'report ssr';\n",
      'node_modules/report-board/dist/views/Index.js': "export default 'report page';\n",
    },
    { 'shared-m': 'modules/demo/m.ts', 'shared-n': 'modules/demo/n.ts' },
  );
}

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
}

describe('an app and a package entry in one client build', () => {
  let root = '';
  let manifest: Record<string, ManifestChunk> = {};
  let first: string[] = [];

  /** Every file below `dist/client/assets`, sorted. */
  const listing = (dir: string) => readdirSync(join(dir, 'dist/client/assets')).sort();
  /** The chunks an entry loads first: its own and, transitively, those it imports statically. */
  const hull = (key: string): string[] => {
    const seen = new Set<string>();
    const walk = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const imported of manifest[name]!.imports ?? []) walk(imported);
    };
    walk(key);
    return [...seen];
  };
  const files = (keys: string[]) => keys.map((key) => manifest[key]!.file);
  const code = (keys: string[]) => files(keys).map((file) => readFileSync(join(root, 'dist/client', file), 'utf8')).join('\n');
  const styles = (keys: string[]) => [...new Set(keys.flatMap((key) => manifest[key]!.css ?? []))].sort();
  const entriesJson = () => JSON.parse(readFileSync(join(root, 'dist/client/.vite/marmeon-entries.json'), 'utf8')) as { format: number; entries: Record<string, { client: string }>; pages: Record<string, string> };

  beforeAll(() => {
    root = twoEntryApp();
    const { code: status, out } = build(root, '--no-typecheck');
    expect(out).toContain('Built dist/client and dist/server');
    expect(status).toBe(0);
    manifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8')) as typeof manifest;
    first = listing(root);
  }, 90_000);

  it('loads no module only the package reaches in the app entry, and none only the app reaches in the package entry', () => {
    const app = code(hull('index.html'));
    const pkg = code(hull(entriesJson().entries.status!.client));
    expect(app).toContain('APP_ONLY_MARK');
    expect(app).toContain('APP_LIB_MARK');
    for (const mark of ['ADMIN_ONLY_MARK', 'ADMIN_LIB_MARK', 'PKGMOD_MARK']) expect(app, mark).not.toContain(mark);
    expect(pkg).toContain('ADMIN_ONLY_MARK');
    expect(pkg).toContain('ADMIN_LIB_MARK');
    expect(pkg).toContain('PKGMOD_MARK');
    for (const mark of ['APP_ONLY_MARK', 'APP_LIB_MARK']) expect(pkg, mark).not.toContain(mark);
  }, 60_000);

  it('keeps the stylesheets of the two entries apart', () => {
    const appStyles = styles(hull('index.html'));
    const pkgStyles = styles(hull(entriesJson().entries.status!.client));
    const read = (list: string[]) => list.map((file) => readFileSync(join(root, 'dist/client', file), 'utf8')).join('\n');
    expect(appStyles.length).toBeGreaterThan(0);
    expect(pkgStyles.length).toBeGreaterThan(0);
    expect(appStyles.filter((file) => pkgStyles.includes(file))).toEqual([]);
    expect(read(appStyles)).toContain('app-css-mark');
    expect(read(appStyles)).not.toContain('admin-css-mark');
    expect(read(pkgStyles)).toContain('admin-css-mark');
    expect(read(pkgStyles)).not.toContain('app-css-mark');
  });

  it('loads from the package only the module a page of the app imports', () => {
    const page = code(hull('modules/demo/views/A.tsx'));
    expect(page).toContain('PKGMOD_MARK');
    for (const mark of ['ADMIN_ONLY_MARK', 'ADMIN_LIB_MARK']) expect(page, mark).not.toContain(mark);
    expect(styles(hull('modules/demo/views/A.tsx')).some((file) => readFileSync(join(root, 'dist/client', file), 'utf8').includes('admin-css-mark'))).toBe(false);
  });

  it('keeps the page of the package from loading app code first, and shares the library both use in one chunk', () => {
    const pkg = hull(entriesJson().entries.status!.client);
    expect(code(pkg)).not.toContain('APP_ONLY_MARK');
    const holders = (keys: string[]) => files(keys).filter((file) => readFileSync(join(root, 'dist/client', file), 'utf8').includes('REACT_MARK'));
    const both = holders(hull('index.html'));
    expect(both).toHaveLength(1);
    expect(holders(pkg)).toEqual(both);
  });

  it('puts only modules an entry reaches itself into the chunks it loads first, unmarked ones included', () => {
    const { status } = entriesJson().entries;
    expect(strays(root, 'index.html', idOf(root, 'index.html'))).toEqual([]);
    expect(strays(root, status!.client, idOf(root, 'node_modules/status-board/dist/client.js'))).toEqual([]);
  });

  it('lists in marmeon-entries.json only keys of the manifest, and builds the server entry of the package', () => {
    const json = entriesJson();
    expect(json.format).toBe(1);
    expect(Object.keys(json.entries)).toEqual(['status']);
    expect(manifest[json.entries.status!.client]!.isEntry).toBe(true);
    expect(Object.keys(json.pages)).toEqual(['status::Index']);
    for (const key of [json.entries.status!.client, ...Object.values(json.pages)]) expect(manifest[key], key).toBeDefined();
    expect(readdirSync(join(root, 'dist/server'))).toEqual(expect.arrayContaining(['ssr.js', 'ssr-status.js']));
    // A chunk both entries share is named by a hash, so a public file name never gives a namespace away.
    const shared = first.filter((file) => /^(?:vendor-)?shared-/.test(file));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.filter((file) => file.includes('status'))).toEqual([]);
  });

  it('makes the same file names in a second build', () => {
    const again = twoEntryApp();
    const { code: status } = build(again, '--no-typecheck');
    expect(status).toBe(0);
    expect(listing(again)).toEqual(first);
  }, 90_000);
});

describe('an app and two package entries in one client build', () => {
  it('keeps a module only two entries reach out of the chunk the third loads, although a dependency of it is reached by all three', () => {
    const root = threeEntryApp();
    const { code: status, out } = build(root, '--no-typecheck');
    expect(out).toContain('Built dist/client and dist/server');
    expect(status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
    const { entries } = JSON.parse(readFileSync(join(root, 'dist/client/.vite/marmeon-entries.json'), 'utf8')) as { entries: Record<string, { client: string }> };
    const first = (key: string) => {
      const seen = new Set<string>();
      const walk = (name: string) => {
        if (seen.has(name)) return;
        seen.add(name);
        for (const imported of manifest[name]!.imports ?? []) walk(imported);
      };
      walk(key);
      return [...seen].map((name) => readFileSync(join(root, 'dist/client', manifest[name]!.file), 'utf8')).join('\n');
    };
    expect(first('index.html')).toContain('M_MARK');
    expect(first(entries.status!.client)).toContain('M_MARK');
    expect(first(entries.report!.client)).not.toContain('M_MARK');
    expect(first(entries.report!.client)).toContain('N_MARK');
    expect(strays(root, 'index.html', idOf(root, 'index.html'))).toEqual([]);
    expect(strays(root, entries.status!.client, idOf(root, 'node_modules/status-board/dist/client.js'))).toEqual([]);
    expect(strays(root, entries.report!.client, idOf(root, 'node_modules/report-board/dist/client.js'))).toEqual([]);
  }, 90_000);
});

describe('an app and a package entry that loads lazily what the app loads first', () => {
  it('keeps a module the package imports dynamically out of its first load, although the framework code it imports is loaded first by both', () => {
    const root = twoEntryApp(
      {
        'bootstrap/client.ts': "import { x } from 'lazy-x';\nimport { y } from 'shared-y';\nimport pages from 'virtual:marmeon/pages';\ndocument.title = `${x} ${y}`;\nfor (const load of Object.values(pages)) void load();\n",
        'modules/demo/y.ts': "export const y = 'Y_MARK';\n",
        'node_modules/lazy-x/package.json': JSON.stringify({ name: 'lazy-x', type: 'module', exports: './index.js' }),
        'node_modules/lazy-x/index.js': "import { y } from 'shared-y';\nexport const x = `X_MARK ${y}`;\n",
        'node_modules/status-board/dist/client.js': "import { y } from 'shared-y';\nimport pages from 'virtual:marmeon/pages/status';\ndocument.title = y;\nvoid import('lazy-x');\nfor (const load of Object.values(pages)) void load();\n",
      },
      { 'shared-y': 'modules/demo/y.ts' },
    );
    const { code: status } = build(root, '--no-typecheck');
    expect(status).toBe(0);
    const { entries } = JSON.parse(readFileSync(join(root, 'dist/client/.vite/marmeon-entries.json'), 'utf8')) as { entries: Record<string, { client: string }> };
    expect(strays(root, 'index.html', idOf(root, 'index.html'))).toEqual([]);
    expect(strays(root, entries.status!.client, idOf(root, 'node_modules/status-board/dist/client.js'))).toEqual([]);
  }, 90_000);
});

describe('a package entry in a build, read as the app is', () => {
  it('takes the package\'s node-only server entry, with a client entry and views that only the browser has a target for', () => {
    const root = twoEntryApp({
      'node_modules/status-board/package.json': JSON.stringify({
        name: 'status-board',
        type: 'module',
        // The client entry and the views have a target for the browser alone, which the server's conditions cannot resolve.
        exports: {
          './client': { browser: './dist/client.js' },
          './ssr': { node: './dist/ssr-node.js' },
          './pkgmod': './dist/pkgmod.js',
          './views/*': { browser: './dist/views/*.js' },
        },
        marmeon: { namespace: 'status', entry: { client: './client', ssr: './ssr' }, views: './views' },
      }),
      'node_modules/status-board/dist/ssr-node.js': "export const render = () => 'NODE_SSR_MARK';\n",
    });
    const { code: status } = build(root, '--no-typecheck');
    expect(status).toBe(0);
    const server = readFileSync(join(root, 'dist/server/ssr-status.js'), 'utf8');
    expect(server).toContain('NODE_SSR_MARK');
  }, 90_000);
});

describe('a build without a package entry', () => {
  it('keeps the chunking and the inputs it had, and writes no marmeon-entries.json', () => {
    const root = app();
    const [main] = marmeon() as unknown as [{ config: (config: object, env: object) => { build: { rolldownOptions: { input?: unknown; output: { codeSplitting: unknown } } } } }];
    const result = main.config({ root }, { command: 'build', mode: 'production', isSsrBuild: false });
    expect(result.build.rolldownOptions.output.codeSplitting).toBe(CLIENT_CHUNKS);
    expect(result.build.rolldownOptions.input).toBeUndefined();
    const server = main.config({ root }, { command: 'build', mode: 'production', isSsrBuild: true });
    expect(server.build.rolldownOptions.input).toEqual({ ssr: join(root, 'bootstrap/ssr.tsx') });

    const { code: status } = build(root, '--no-typecheck');
    expect(status).toBe(0);
    expect(readdirSync(join(root, 'dist/client/.vite'))).toEqual(['manifest.json']);
    expect(readdirSync(join(root, 'dist/server')).filter((file) => file.startsWith('ssr-'))).toEqual([]);
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
    const root = serverCodeApp({ 'modules/demo/views/Home.tsx': "import { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport default (page: ShowHomeController) => page;\n" });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain(
      "[marmeon] modules/demo/views/Home.tsx:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value: a controller is server code, and a value import bundles it — with everything it imports — into the browser. A class is a value even where only its type is used: write import type { ShowHomeController } from '../controllers/ShowHomeController.ts'.",
    );
    expect(out).toContain('✗ Not built: 1 import brings server code into the browser.');
    expect(out).not.toContain('RolldownError');
    expect(out).not.toContain('Built dist/client');
    expect(code).toBe(1);
  }, 60_000);

  it('fails it for an indirect import too (page → helper → controller), naming the helper and the chain', () => {
    const root = serverCodeApp({
      'modules/demo/helpers.ts': "import { ShowHomeController } from './controllers/ShowHomeController.ts';\nexport const label = () => ShowHomeController.name;\n",
      'modules/demo/views/Home.tsx': "import { label } from '../helpers.ts';\nexport default label();\n",
    });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain(
      '[marmeon] modules/demo/helpers.ts:1:1 — imports modules/demo/controllers/ShowHomeController.ts as a value (modules/demo/helpers.ts is client code: modules/demo/views/Home.tsx → modules/demo/helpers.ts): a controller is server code',
    );
    expect(code).toBe(1);
  }, 60_000);

  it('builds a page that imports the controller with import type or re-exports its type — the controller stays on the server, where SSR may import it', () => {
    const root = serverCodeApp({
      'modules/demo/views/Home.tsx': "import type { ShowHomeController } from '../controllers/ShowHomeController.ts';\nexport type { ShowHomeController as Page } from '../controllers/ShowHomeController.ts';\nexport default (page?: ShowHomeController) => `home page ${typeof page}`;\n",
    });
    const { code, out } = build(root, '--no-typecheck');
    expect(out).toContain('Built dist/client and dist/server');
    expect(code).toBe(0);
    expect(bundle(join(root, 'dist/client'))).not.toContain('server-only-secret');
    expect(bundle(join(root, 'dist/server'))).toContain('server-only-secret');
  }, 60_000);

  it('fails the build for a value import from a folder package.json declares, and stops early on a broken declaration', () => {
    const declared = serverCodeApp({
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@marmeon/fake': '*' }, marmeon: { serverModules: ['modules/*/invoices/**'] } }),
      'modules/demo/invoices/Table.ts': "export const table = 'server-only-invoices';\n",
      'modules/demo/views/Home.tsx': "import { table } from '../invoices/Table.ts';\nexport default () => table;\n",
    });
    const refused = build(declared, '--no-typecheck');
    expect(refused.out).toContain('a module of package.json\'s "serverModules" (modules/*/invoices/**) is server code');
    expect(refused.out).toContain('✗ Not built: 1 import brings server code into the browser.');
    expect(refused.code).toBe(1);

    const broken = serverCodeApp({
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { '@marmeon/fake': '*' }, marmeon: { serverModules: 'modules/x/**' } }),
      'modules/demo/views/Home.tsx': 'export default () => 1;\n',
    });
    const stopped = build(broken, '--no-typecheck');
    expect(stopped.out).toContain('Not built: [marmeon:H14]');
    expect(stopped.out).not.toMatch(/\n\s+at /);
    expect(stopped.code).toBe(1);
  }, 60_000);
});
