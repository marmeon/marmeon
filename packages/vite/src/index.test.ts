import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeConfig, resolveConfig, type ConfigEnv, type Plugin, type UserConfig } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { adapterPeers, marmeon, CLIENT_CHUNKS, PLUGIN_NAME, SOURCE_CONDITION, virtualGlob, type MarmeonOptions, type MarmeonPluginApi } from './plugin.ts';
import { routesModule } from './routes-module.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function tree(files: Record<string, unknown>): string {
  const root = tempDir('marmeon-vite-unit-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const app = tree({
  'package.json': { dependencies: { '@marmeon/react': '*', '@marmeon/mail': '*', 'third-party-adapter': '*', lodash: '*' } },
  'node_modules/@marmeon/react/package.json': { peerDependencies: { react: '^19', 'react-dom': '^19' } },
  'node_modules/@marmeon/mail/package.json': { peerDependencies: { mjml: '^5' }, peerDependenciesMeta: { mjml: { optional: true } } },
  'node_modules/third-party-adapter/package.json': { marmeon: {}, peerDependencies: { svelte: '^5' } },
  'node_modules/lodash/package.json': { peerDependencies: { 'not-ours': '*' } },
});

function main(plugins: Plugin[]): Plugin & { api: MarmeonPluginApi } {
  return plugins.find((plugin) => plugin.name === PLUGIN_NAME) as Plugin & { api: MarmeonPluginApi };
}

function configFor(plugins: Plugin[], env: Partial<ConfigEnv>): UserConfig {
  const hook = main(plugins).config as (config: UserConfig, env: ConfigEnv) => UserConfig;
  return hook({ root: app }, { command: 'serve', mode: 'development', ...env } as ConfigEnv);
}

describe('marmeon()', () => {
  it('resolves workspace sources while serving and in tests — never in a build', () => {
    const dev = configFor(marmeon(), { command: 'serve', mode: 'development' });
    expect(dev.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);
    expect(dev.ssr?.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);
    const test = configFor(marmeon({ test: true }), { command: 'serve', mode: 'test' });
    expect(test.ssr?.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);
    // Tests resolve server code as Node does: `module` is a bundler's condition (Vitest passes these to its workers).
    expect(test.ssr?.resolve?.conditions).not.toContain('module');
    expect(test.ssr?.resolve?.conditions).toContain('node');

    for (const env of [{ command: 'build', mode: 'production' }, { command: 'build', mode: 'development' }, { command: 'serve', mode: 'production' }, { command: 'serve', mode: 'staging' }] as const) {
      const config = configFor(marmeon(), env);
      expect(config.resolve?.conditions).not.toContain(SOURCE_CONDITION);
      expect(config.ssr?.resolve?.conditions).not.toContain(SOURCE_CONDITION);
      expect(config.ssr?.resolve?.conditions).toContain('node'); // Vite's defaults stay
    }
  });

  it('reads no .env file and has no public variable prefix — unless viteEnv hands Vite its own behaviour back', () => {
    for (const env of [{ command: 'serve', mode: 'development' }, { command: 'build', mode: 'production' }] as const) {
      const config = configFor(marmeon(), env);
      expect(config.envDir).toBe(false);
      expect(config.envPrefix).toBe('__MARMEON_NO_PUBLIC_ENV__');
      expect(configFor(marmeon({ test: true }), env).envDir).toBe(false);
      const open = configFor(marmeon({ viteEnv: true }), env);
      expect(open).not.toHaveProperty('envDir');
      expect(open).not.toHaveProperty('envPrefix');
    }
  });

  it('refuses an own envDir or envPrefix, and a prefix another plugin adds — unless viteEnv is set', async () => {
    const resolve = (config: UserConfig, plugin: Plugin[] = marmeon()) => resolveConfig({ root: app, configFile: false, logLevel: 'silent', ...config, plugins: [plugin, { name: 'adds', config: () => ({}) }] }, 'serve');
    await expect(resolve({})).resolves.toMatchObject({ envDir: false, envPrefix: '__MARMEON_NO_PUBLIC_ENV__' });
    await expect(resolve({ envPrefix: ['APP_'] })).rejects.toThrow(/viteEnv: true/);
    await expect(resolve({ envPrefix: 'APP_' })).rejects.toThrow(/viteEnv: true/);
    await expect(resolve({ envDir: '.' })).rejects.toThrow(/viteEnv: true/);
    await expect(resolve({}, [...marmeon(), { name: 'adds-prefix', config: () => ({ envPrefix: ['PUBLIC_'] }) }])).rejects.toThrow(/viteEnv: true/);
    await expect(resolve({ envPrefix: ['APP_'] }, marmeon({ viteEnv: true }))).resolves.toMatchObject({ envPrefix: ['APP_'] });
  });

  it('refuses a build whose base is a path or relative, since the server serves dist/client under / — a URL and / pass', async () => {
    const resolve = (base: string, command: 'build' | 'serve' = 'build') => resolveConfig({ root: app, configFile: false, logLevel: 'silent', base, plugins: [marmeon()] }, command);
    for (const base of ['./', '/static/', 'https://u:p@cdn.example/', 'https://cdn.example/?v=1/', 'https://cdn.example/a/../b/']) await expect(resolve(base)).rejects.toThrow(/`base` must be '\/' or an absolute URL/);
    await expect(resolve('/')).resolves.toMatchObject({ base: '/' });
    await expect(resolve('https://cdn.example/app/')).resolves.toMatchObject({ base: 'https://cdn.example/app/' });
    await expect(resolve('/static/', 'serve')).resolves.toMatchObject({ base: '/static/' });
  });

  it('builds the client to dist/client and the SSR entry to dist/server/ssr.js — not in test mode', () => {
    expect(configFor(marmeon(), { command: 'build', mode: 'production' }).build).toEqual({ outDir: 'dist/client', emptyOutDir: true, manifest: true, rolldownOptions: { output: { codeSplitting: CLIENT_CHUNKS } } });
    expect(configFor(marmeon({ entries: { ssr: 'src/server.tsx' } }), { command: 'build', mode: 'production', isSsrBuild: true }).build).toEqual({
      outDir: 'dist/server',
      emptyOutDir: true,
      rolldownOptions: { input: { ssr: join(app, 'src/server.tsx') } },
    });
    expect(configFor(marmeon({ test: true }), { command: 'build', mode: 'production' }).build).toBeUndefined();
  });

  it('writes Vite\'s manifest for the client build only — not for the SSR build, tests or serving', () => {
    expect(configFor(marmeon(), { command: 'build', mode: 'production' }).build).toMatchObject({ manifest: true });
    expect(configFor(marmeon(), { command: 'build', mode: 'production', isSsrBuild: true }).build).not.toHaveProperty('manifest');
    expect(configFor(marmeon({ test: true }), { command: 'build', mode: 'production' }).build).toBeUndefined();
    expect(configFor(marmeon(), { command: 'serve', mode: 'development' }).build).toBeUndefined();
  });

  it('denies storage, databases and build output to the dev server — next to Vite\'s own list, and an app\'s list stays', () => {
    const deny = configFor(marmeon(), { command: 'serve', mode: 'development' }).server?.fs?.deny ?? [];
    expect(deny).toEqual(expect.arrayContaining(['.env', '.env.*', '**/.git/**', '**/*.sqlite', '**/*.sqlite-*', '**/*.sqlite3', '**/*.sqlite3-*', '**/*.db', '**/*.db-*', '**/*.db3', '**/*.db3-*']));
    expect(deny.some((pattern) => pattern.endsWith('/storage/**') && pattern.startsWith('/'))).toBe(true);
    expect(deny.some((pattern) => pattern.endsWith('/dist/**'))).toBe(true);
    expect(deny.some((pattern) => pattern.endsWith('/.marmeon/**'))).toBe(true);
    const merged = mergeConfig({ server: { fs: { deny: ['secrets/**'] } } }, configFor(marmeon(), { command: 'serve', mode: 'development' }));
    expect(merged.server?.fs?.deny).toEqual(expect.arrayContaining(['secrets/**', '.env', '**/*.sqlite']));
    // Tests and builds keep Vite's defaults.
    expect(configFor(marmeon({ test: true }), { command: 'serve', mode: 'test' }).server).toBeUndefined();
    expect(configFor(marmeon(), { command: 'build', mode: 'production' }).server).toBeUndefined();
  });

  it('keeps every default of Vite\'s deny list, whatever its version holds', async () => {
    const defaults = (await resolveConfig({ root: app, configFile: false, logLevel: 'silent' }, 'serve')).server.fs.deny;
    expect(defaults.length).toBeGreaterThan(0);
    expect(configFor(marmeon(), { command: 'serve', mode: 'development' }).server?.fs?.deny).toEqual(expect.arrayContaining(defaults));
  });

  it('denies the app\'s directories under the root as written and as resolved — a symlinked root with preserveSymlinks', () => {
    const real = tree({ 'package.json': {} });
    const link = `${tempDir('marmeon-vite-unit-')}/linked`;
    symlinkSync(real, link, 'dir');
    const hook = main(marmeon()).config as (config: UserConfig, env: ConfigEnv) => UserConfig;
    const deny = hook({ root: link, resolve: { preserveSymlinks: true } }, { command: 'serve', mode: 'development' } as ConfigEnv).server?.fs?.deny ?? [];
    expect(deny).toEqual(expect.arrayContaining([`${link}/storage/**`, `${realpathSync(real)}/storage/**`]));
  });

  it('pre-bundles from the client entry and the pages — and the devtools\' bar when an installed package brings it (no reload on the first request)', () => {
    const dev = configFor(marmeon(), { command: 'serve', mode: 'development' });
    expect(dev.optimizeDeps?.entries).toEqual(['bootstrap/client.tsx', 'modules/*/views/**/*.tsx']);
    expect(dev.optimizeDeps?.include).toEqual([]); // no devtools installed
    const withDevtools = tree({ 'package.json': {}, 'node_modules/@marmeon/devtools/package.json': { name: '@marmeon/devtools' } });
    const hook = main(marmeon()).config as (config: UserConfig, env: ConfigEnv) => UserConfig;
    expect(hook({ root: withDevtools }, { command: 'serve', mode: 'development' } as ConfigEnv).optimizeDeps?.include).toEqual(['@marmeon/devtools/client']);
    // A workspace link (the monorepo's sources) is never pre-bundled.
    const linked = tree({ 'package.json': {}, 'packages/devtools/package.json': { name: '@marmeon/devtools' } });
    mkdirSync(join(linked, 'node_modules/@marmeon'), { recursive: true });
    symlinkSync(join(linked, 'packages/devtools'), join(linked, 'node_modules/@marmeon/devtools'), 'dir');
    expect(hook({ root: linked }, { command: 'serve', mode: 'development' } as ConfigEnv).optimizeDeps?.include).toEqual([]);
    expect(configFor(marmeon(), { command: 'build', mode: 'production' }).optimizeDeps).toBeUndefined();
    expect(configFor(marmeon({ test: true }), { command: 'serve', mode: 'test' }).optimizeDeps).toBeUndefined();
  });

  it('dedupes the required peers of framework packages only (one React for adapter and app)', () => {
    expect(configFor(marmeon(), {}).resolve?.dedupe).toEqual(['react', 'react-dom', 'svelte']);
    expect(adapterPeers(tree({}))).toEqual([]);
  });

  it('exposes its entries to the server and adds the client entry to index.html', () => {
    expect(main(marmeon()).api.entries).toEqual({ client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' });
    expect(main(marmeon({ entries: { client: 'src/main.ts' } })).api.entries).toEqual({ client: 'src/main.ts', ssr: 'bootstrap/ssr.tsx' });

    const html = (plugins: Plugin[], source: string) => (main(plugins).transformIndexHtml as { handler: (html: string) => unknown }).handler(source);
    expect(html(marmeon(), '<body></body>')).toEqual([{ tag: 'script', attrs: { type: 'module', src: '/bootstrap/client.tsx' }, injectTo: 'body' }]);
    // An index.html that names the entry itself keeps it (no second script tag), and tests have no HTML.
    expect(html(marmeon(), '<script type="module" src="/bootstrap/client.tsx"></script>')).toBeUndefined();
    expect(html(marmeon({ test: true }), '<body></body>')).toBeUndefined();
  });

  it('refuses the removed options pages and lang with a hint to the fixed conventions', () => {
    // @ts-expect-error `pages` was removed
    expect(() => marmeon({ pages: 'views/*.tsx' })).toThrow(new TypeError('marmeon(): `pages` was removed: page components live in `modules/<module>/views/` (docs/vite.md#options). Remove it from `marmeon()`.'));
    // @ts-expect-error `lang` was removed
    expect(() => marmeon({ lang: ['lang/*.ts'] })).toThrow(/`lang` was removed: language files live in `lang\/` and `modules\/<module>\/lang\/`/);
    expect(() => marmeon({ pages: undefined } as never)).not.toThrow();
    expect(() => marmeon({})).not.toThrow();
  });

  it('runs the constructor-injection transform and serves virtual:marmeon/pages, virtual:marmeon/lang and virtual:marmeon/routes', () => {
    const plugins = marmeon();
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'marmeon',
      'marmeon:async-entry',
      'marmeon:injection',
      'marmeon:virtual-pages',
      'marmeon:virtual-lang',
      'marmeon:routes',
      'marmeon:server-imports',
      'marmeon:images',
    ]);
    const lang = plugins.find((plugin) => plugin.name === 'marmeon:virtual-lang')!;
    // Lazy: one chunk per language file, the browser loads only its locale's.
    expect((lang.load as (id: string) => unknown)('\0virtual:marmeon/lang')).toBe('export default import.meta.glob(["/modules/*/lang/*.ts","/lang/*.ts"]);\n');
  });
});

describe('virtualGlob()', () => {
  const call = (plugin: Plugin, hook: 'resolveId' | 'load', arg: string) => (plugin[hook] as (id: string) => unknown)(arg);

  it('is an import.meta.glob at one place, relative to the app root', () => {
    const pages = virtualGlob('pages', 'modules/*/views/**/*.tsx');
    expect(call(pages, 'resolveId', 'virtual:marmeon/pages')).toBe('\0virtual:marmeon/pages');
    expect(call(pages, 'resolveId', 'virtual:marmeon/lang')).toBeUndefined();
    expect(call(pages, 'load', '\0virtual:marmeon/pages')).toBe('export default import.meta.glob(["/modules/*/views/**/*.tsx"]);\n');
    expect(call(pages, 'load', '/modules/a.ts')).toBeUndefined();
  });

  it('takes several patterns, negations, and eager loading (for language files)', () => {
    const lang = virtualGlob('lang', ['modules/*/lang/*.ts', '!modules/*/lang/*.test.ts'], { eager: true });
    expect(call(lang, 'load', '\0virtual:marmeon/lang')).toBe(
      'export default import.meta.glob(["/modules/*/lang/*.ts","!/modules/*/lang/*.test.ts"], { eager: true });\n',
    );
  });
});

// Type guarantees (never called: type-test bodies would run in Vitest).
export function typeTests(): void {
  // @ts-expect-error — an unknown option is a typo, not silently ignored
  marmeon({ entry: 'bootstrap/client.tsx' });
  // @ts-expect-error — entries are paths
  marmeon({ entries: { ssr: true } });
  // @ts-expect-error — an unknown entry
  marmeon({ entries: { server: 'bootstrap/ssr.tsx' } });
  marmeon({ entries: { client: 'bootstrap/client.tsx' } });
  const options: MarmeonOptions['entries'] = { ssr: 'bootstrap/ssr.tsx' };
  void options;
}

// The entries object the server reads stays internal: neither type is part of the package's entry.
// @ts-expect-error — not exported
export type NotExportedEntries = import('./index.ts').MarmeonEntries;
// @ts-expect-error — not exported
export type NotExportedApi = import('./index.ts').MarmeonPluginApi;

describe('virtual:marmeon/routes while serving', () => {
  const root = tree({
    '.marmeon/routes.json': {
      version: 1,
      routes: { home: { method: 'get', path: '/' }, 'admin.secret': { method: 'get', path: '/admin' } },
      hidden: { 'verify.link': 'internal' },
    },
  });
  const plugin = routesModule();
  const context = { addWatchFile() {}, error(message: string): never { throw new Error(message); }, environment: { config: { consumer: 'client' } } };
  (plugin.configResolved as (config: unknown) => void)({ root, command: 'serve' });
  const load = () => (plugin.load as (this: unknown, id: string) => string).call(context, '\0virtual:marmeon/routes');
  const transform = (code: string) =>
    (plugin.transform as (this: unknown, code: string, id: string) => { code: string } | undefined).call(context, code, join(root, 'modules/demo/views/Page.tsx'));

  it('has every route the browser may learn, and warns once for a name no module declared — production would lack it', async () => {
    const module = (await import(`data:text/javascript,${encodeURIComponent(load())}`)) as {
      routes: Record<string, unknown>;
      __referenceRoutes(names: string[]): void;
    };
    expect(Object.keys(module.routes)).toEqual(['home', 'admin.secret']);
    expect(Object.hasOwn(module.routes, 'verify.link')).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      module.__referenceRoutes(['home']);
      expect(Object.hasOwn(module.routes, 'home') && module.routes.home).toEqual({ method: 'get', path: '/' });
      expect(warn).not.toHaveBeenCalled();
      void module.routes['admin.secret'];
      void module.routes['admin.secret'];
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('Route [admin.secret] is resolved, but no module writes it out');
    } finally {
      warn.mockRestore();
    }
  });

  it('declares each module\'s names to the manifest, and fails a module that builds one at runtime — the dev overlay shows it', () => {
    const page = "import { Link } from '@marmeon/react';\nexport default () => <Link route=\"home\">Home</Link>;\n";
    expect(transform(page)?.code).toBe(
      `${page}\nimport { __referenceRoutes as __marmeonReferenceRoutes } from 'virtual:marmeon/routes';\n__marmeonReferenceRoutes(["home"]);\n`,
    );
    expect(transform("export const nothing = 'here';\n")).toBeUndefined();
    expect(() => transform("import { Link } from '@marmeon/react';\nexport default ({ to }) => <Link route={`admin.${to}`} />;\n")).toThrow(
      "[marmeon] modules/demo/views/Page.tsx:2:41 — route names sent to the browser must be written out: `admin.${to}` (<Link route>) is built at runtime, " +
        "so the build cannot tell which routes this page needs. Did you mean admin.secret? Write it as a literal: 'admin.secret'.",
    );
    expect(() => transform("import { useRoute } from '@marmeon/react';\nexport const A = () => useRoute()('verify.lnk');\n")).toThrow(
      "'verify.lnk' is not a route name (run marmeon route:types after adding a route).",
    );
  });
});
