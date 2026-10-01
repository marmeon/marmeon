import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { adapterPeers, bespoke, PLUGIN_NAME, routesModule, SOURCE_CONDITION, virtualGlob, type BespokePluginApi } from './index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'bespoke-vite-unit-'));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const app = tree({
  'package.json': { dependencies: { '@bespokecore/react': '*', '@bespokecore/mail': '*', 'third-party-adapter': '*', lodash: '*' } },
  'node_modules/@bespokecore/react/package.json': { peerDependencies: { react: '^19', 'react-dom': '^19' } },
  'node_modules/@bespokecore/mail/package.json': { peerDependencies: { mjml: '^5' }, peerDependenciesMeta: { mjml: { optional: true } } },
  'node_modules/third-party-adapter/package.json': { bespoke: {}, peerDependencies: { svelte: '^5' } },
  'node_modules/lodash/package.json': { peerDependencies: { 'not-ours': '*' } },
});

function main(plugins: Plugin[]): Plugin & { api: BespokePluginApi } {
  return plugins.find((plugin) => plugin.name === PLUGIN_NAME) as Plugin & { api: BespokePluginApi };
}

function configFor(plugins: Plugin[], env: Partial<ConfigEnv>): UserConfig {
  const hook = main(plugins).config as (config: UserConfig, env: ConfigEnv) => UserConfig;
  return hook({ root: app }, { command: 'serve', mode: 'development', ...env } as ConfigEnv);
}

describe('bespoke()', () => {
  it('resolves workspace sources while serving and in tests — never in a build', () => {
    const dev = configFor(bespoke(), { command: 'serve', mode: 'development' });
    expect(dev.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);
    expect(dev.ssr?.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);
    expect(configFor(bespoke({ test: true }), { command: 'serve', mode: 'test' }).ssr?.resolve?.conditions?.[0]).toBe(SOURCE_CONDITION);

    for (const env of [{ command: 'build', mode: 'production' }, { command: 'build', mode: 'development' }, { command: 'serve', mode: 'production' }] as const) {
      const config = configFor(bespoke(), env);
      expect(config.resolve?.conditions).not.toContain(SOURCE_CONDITION);
      expect(config.ssr?.resolve?.conditions).not.toContain(SOURCE_CONDITION);
      expect(config.ssr?.resolve?.conditions).toContain('node'); // Vite's defaults stay
    }
  });

  it('builds the client to dist/client and the SSR entry to dist/server/ssr.js — not in test mode', () => {
    expect(configFor(bespoke(), { command: 'build', mode: 'production' }).build).toEqual({ outDir: 'dist/client', emptyOutDir: true });
    expect(configFor(bespoke({ entries: { ssr: 'src/server.tsx' } }), { command: 'build', mode: 'production', isSsrBuild: true }).build).toEqual({
      outDir: 'dist/server',
      emptyOutDir: true,
      rolldownOptions: { input: { ssr: join(app, 'src/server.tsx') } },
    });
    expect(configFor(bespoke({ test: true }), { command: 'build', mode: 'production' }).build).toBeUndefined();
  });

  it('dedupes the required peers of framework packages only (one React for adapter and app)', () => {
    expect(configFor(bespoke(), {}).resolve?.dedupe).toEqual(['react', 'react-dom', 'svelte']);
    expect(adapterPeers(tree({}))).toEqual([]);
  });

  it('exposes its entries to the server and adds the client entry to index.html', () => {
    expect(main(bespoke()).api.entries).toEqual({ client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' });
    expect(main(bespoke({ entries: { client: 'src/main.ts' } })).api.entries).toEqual({ client: 'src/main.ts', ssr: 'bootstrap/ssr.tsx' });

    const html = (plugins: Plugin[], source: string) => (main(plugins).transformIndexHtml as { handler: (html: string) => unknown }).handler(source);
    expect(html(bespoke(), '<body></body>')).toEqual([{ tag: 'script', attrs: { type: 'module', src: '/bootstrap/client.tsx' }, injectTo: 'body' }]);
    // An index.html that names the entry itself keeps it (no second script tag), and tests have no HTML.
    expect(html(bespoke(), '<script type="module" src="/bootstrap/client.tsx"></script>')).toBeUndefined();
    expect(html(bespoke({ test: true }), '<body></body>')).toBeUndefined();
  });

  it('runs the constructor-injection transform and serves virtual:bespoke/pages, virtual:bespoke/lang and virtual:bespoke/routes', () => {
    const plugins = bespoke();
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'bespokecore',
      'bespokecore:async-entry',
      'bespokecore:injection',
      'bespokecore:virtual-pages',
      'bespokecore:virtual-lang',
      'bespokecore:routes',
    ]);
    const lang = plugins.find((plugin) => plugin.name === 'bespokecore:virtual-lang')!;
    // Lazy: one chunk per language file, the browser loads only its locale's.
    expect((lang.load as (id: string) => unknown)('\0virtual:bespoke/lang')).toBe('export default import.meta.glob(["/modules/*/lang/*.ts","/lang/*.ts"]);\n');
  });
});

describe('virtualGlob()', () => {
  const call = (plugin: Plugin, hook: 'resolveId' | 'load', arg: string) => (plugin[hook] as (id: string) => unknown)(arg);

  it('is an import.meta.glob at one place, relative to the app root', () => {
    const pages = virtualGlob('pages', 'modules/*/views/**/*.tsx');
    expect(call(pages, 'resolveId', 'virtual:bespoke/pages')).toBe('\0virtual:bespoke/pages');
    expect(call(pages, 'resolveId', 'virtual:bespoke/lang')).toBeUndefined();
    expect(call(pages, 'load', '\0virtual:bespoke/pages')).toBe('export default import.meta.glob(["/modules/*/views/**/*.tsx"]);\n');
    expect(call(pages, 'load', '/modules/a.ts')).toBeUndefined();
  });

  it('takes several patterns, negations, and eager loading (for language files)', () => {
    const lang = virtualGlob('lang', ['modules/*/lang/*.ts', '!modules/*/lang/*.test.ts'], { eager: true });
    expect(call(lang, 'load', '\0virtual:bespoke/lang')).toBe(
      'export default import.meta.glob(["/modules/*/lang/*.ts","!/modules/*/lang/*.test.ts"], { eager: true });\n',
    );
  });
});

// Type guarantees (never called: type-test bodies would run in Vitest).
export function typeTests(): void {
  // @ts-expect-error — an unknown option is a typo, not silently ignored
  bespoke({ entry: 'bootstrap/client.tsx' });
  // @ts-expect-error — entries are paths
  bespoke({ entries: { ssr: true } });
  // @ts-expect-error — an unknown entry
  bespoke({ entries: { server: 'bootstrap/ssr.tsx' } });
}

describe('virtual:bespoke/routes while serving', () => {
  const root = tree({
    '.bespoke/routes.json': {
      version: 1,
      routes: { home: { method: 'get', path: '/' }, 'admin.secret': { method: 'get', path: '/admin' } },
      hidden: { 'verify.link': 'internal' },
    },
  });
  const plugin = routesModule();
  const context = { addWatchFile() {}, error(message: string): never { throw new Error(message); }, environment: { config: { consumer: 'client' } } };
  (plugin.configResolved as (config: unknown) => void)({ root, command: 'serve' });
  const load = () => (plugin.load as (this: unknown, id: string) => string).call(context, '\0virtual:bespoke/routes');
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
    const page = "import { Link } from '@bespokecore/react';\nexport default () => <Link route=\"home\">Home</Link>;\n";
    expect(transform(page)?.code).toBe(
      `${page}\nimport { __referenceRoutes as __bespokeReferenceRoutes } from 'virtual:bespoke/routes';\n__bespokeReferenceRoutes(["home"]);\n`,
    );
    expect(transform("export const nothing = 'here';\n")).toBeUndefined();
    expect(() => transform("import { Link } from '@bespokecore/react';\nexport default ({ to }) => <Link route={`admin.${to}`} />;\n")).toThrow(
      "[bespoke] modules/demo/views/Page.tsx:2:41 — route names sent to the browser must be written out: `admin.${to}` (<Link route>) is built at runtime, " +
        "so the build cannot tell which routes this page needs. Did you mean admin.secret? Write it as a literal: 'admin.secret'.",
    );
    expect(() => transform("import { useRoute } from '@bespokecore/react';\nexport const A = () => useRoute()('verify.lnk');\n")).toThrow(
      "'verify.lnk' is not a route name (run bespoke route:types after adding a route).",
    );
  });
});
