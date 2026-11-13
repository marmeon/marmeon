import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeConfig, searchForWorkspaceRoot, type ConfigEnv, type Plugin, type UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { codeString, PACKAGE_ENTRY_MARK, packagePages, uiPackages } from './package-pages.ts';
import { marmeon, PLUGIN_NAME } from './plugin.ts';
import { routesModule } from './routes-module.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function tree(files: Record<string, unknown>): string {
  const root = realpathSync(tempDir('marmeon-vite-ui-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

/** A package that declares a namespace, with one page and a client entry. */
const statusBoard = {
  'node_modules/status-board/package.json': {
    name: 'status-board',
    type: 'module',
    exports: { './client': './dist/client.js', './ssr': './dist/ssr.js', './views/*': './dist/views/*.js' },
    marmeon: { namespace: 'status', entry: { client: './client', ssr: './ssr' }, views: './views' },
  },
  'node_modules/status-board/dist/client.js': 'export {};\n',
  'node_modules/status-board/dist/ssr.js': 'export {};\n',
  'node_modules/status-board/dist/views/Index.js': 'export default 1;\n',
  'node_modules/status-board/dist/views/entries/Edit.js': 'export default 2;\n',
};
/** Another package of the app: it carries no namespace, so its code is not the app's own. */
const plainPackage = {
  'node_modules/plain-lib/package.json': { name: 'plain-lib', type: 'module', exports: './index.js', marmeon: { providers: [] } },
  'node_modules/plain-lib/index.js': 'export {};\n',
};
const appWith = (files: Record<string, unknown> = statusBoard, dependencies: Record<string, string> = { 'status-board': '*', 'plain-lib': '*' }) =>
  tree({ 'package.json': { name: 'app', private: true, type: 'module', dependencies }, ...plainPackage, ...files });

function main(plugins: Plugin[]): Plugin & { api: { surfaces: readonly unknown[] } } {
  return plugins.find((plugin) => plugin.name === PLUGIN_NAME) as Plugin & { api: { surfaces: readonly unknown[] } };
}

function configFor(root: string, env: Partial<ConfigEnv>, test = false, user: UserConfig = {}): { config: UserConfig; plugins: Plugin[] } {
  const plugins = marmeon(test ? { test: true } : {});
  const hook = main(plugins).config as (config: UserConfig, env: ConfigEnv) => UserConfig;
  return { config: hook({ root, ...user }, { command: 'serve', mode: 'development', ...env } as ConfigEnv), plugins };
}

const context = { error(message: string): never { throw new Error(message); } };
const call = (plugin: Plugin, hook: 'resolveId' | 'load', ...args: unknown[]) => (plugin[hook] as (this: unknown, ...args: unknown[]) => unknown).call(context, ...args);

describe('the packages that declare a namespace', () => {
  it('reads the namespace packages with their real directory, and no other package', () => {
    const root = appWith();
    const found = uiPackages(root, ['import']);
    expect(found.map((surface) => surface.namespace)).toEqual(['status']);
    expect(found[0]!.dir).toBe(join(root, 'node_modules/status-board'));
  });

  it('finds nothing in an app whose package.json is missing or unreadable, leaving the report to the checks that name the file', () => {
    expect(uiPackages(tree({ 'package.json': '{ "marmeon": nonsense' }), ['import'])).toEqual([]);
    expect(uiPackages(tree({}), ['import'])).toEqual([]);
  });

  it('puts exactly those packages through the app\'s plugin chain: not pre-bundled, not external, their entries scanned, their folders served', () => {
    const root = appWith();
    const { config } = configFor(root, {});
    expect(config.ssr?.noExternal).toEqual(['status-board']);
    expect(config.optimizeDeps?.exclude).toEqual(['status-board']);
    expect(config.optimizeDeps?.entries).toContain(join(root, 'node_modules/status-board/dist/client.js'));
    // `allow` replaces Vite's default, so the workspace comes back with the package folder; the deny list stays.
    expect(config.server?.fs?.allow).toEqual([searchForWorkspaceRoot(root), join(root, 'node_modules/status-board')]);
    expect(config.server?.fs?.deny).toContain('.env');

    const built = configFor(root, { command: 'build', mode: 'production' }).config;
    expect(built.ssr?.noExternal).toEqual(['status-board']);
    expect(built.optimizeDeps).toBeUndefined();
    expect(built.server).toBeUndefined();
  });

  it('adds the package folders to an app\'s own `server.fs.allow` without handing it the workspace', () => {
    const root = appWith();
    const { config } = configFor(root, {}, false, { server: { fs: { allow: ['src'] } } });
    const merged = mergeConfig({ server: { fs: { allow: ['src'] } } }, config);
    expect(merged.server?.fs?.allow).toEqual(['src', join(root, 'node_modules/status-board')]);
    expect(merged.server?.fs?.allow).not.toContain(searchForWorkspaceRoot(root));
  });

  it('writes a client entry whose path holds glob characters as a glob that matches only that file', () => {
    const odd = tree({
      'package.json': { name: 'app', dependencies: { 'status-board': '*' } },
      ...Object.fromEntries(Object.entries(statusBoard).map(([path, content]) => [path.replace('node_modules/status-board', 'pkgs/[a](b){c}/status-board'), content])),
    });
    const home = join(odd, 'pkgs/[a](b){c}/status-board');
    mkdirSync(join(odd, 'node_modules'));
    symlinkSync(home, join(odd, 'node_modules/status-board'), 'dir');
    const entry = configFor(odd, {}).config.optimizeDeps?.entries as string[];
    expect(entry).toContain(`${join(home, 'dist/client.js').replace(/[[\]{}()]/g, (char) => `\\${char}`)}`);
    expect(entry.some((glob) => glob.includes('[a]'))).toBe(false);
  });

  it('leaves an app without such a package as it was, and a vitest config alone', () => {
    const plain = appWith({}, { 'plain-lib': '*' });
    const { config } = configFor(plain, {});
    expect(config.ssr).not.toHaveProperty('noExternal');
    expect(config.optimizeDeps).not.toHaveProperty('exclude');
    expect(config.server?.fs).not.toHaveProperty('allow');

    const test = configFor(appWith(), { mode: 'test' }, true).config;
    expect(test.ssr).not.toHaveProperty('noExternal');
    expect(test).not.toHaveProperty('optimizeDeps');
  });

  it('hands the surfaces to the server through the plugin api', () => {
    const { plugins } = configFor(appWith(), {});
    expect(main(plugins).api.surfaces).toMatchObject([{ package: 'status-board', namespace: 'status' }]);
  });

  it('adds no app client to a document that carries the package entry mark', () => {
    const handler = (main(marmeon()).transformIndexHtml as { handler: (html: string) => unknown }).handler;
    expect(handler('<html><body></body></html>')).toEqual([expect.objectContaining({ tag: 'script' })]);
    expect(handler(`<html><body>${PACKAGE_ENTRY_MARK}</body></html>`)).toBeUndefined();
  });
});

describe('virtual:marmeon/pages/<namespace>', () => {
  const pluginFor = (root: string) => {
    const found = uiPackages(root, ['import']);
    return packagePages(() => found);
  };
  const pagesOf = (root: string, namespace = 'status') => {
    const plugin = pluginFor(root);
    const id = call(plugin, 'resolveId', `virtual:marmeon/pages/${namespace}`) as string;
    return call(plugin, 'load', id) as string;
  };

  it('lists every view of the package under `<namespace>::<view>`, with its real path, loaded lazily', () => {
    const root = appWith();
    const dir = join(root, 'node_modules/status-board/dist/views');
    expect(pagesOf(root)).toBe(
      `export default {\n  "status::Index": () => import(${JSON.stringify(join(dir, 'Index.js'))}),\n  "status::entries/Edit": () => import(${JSON.stringify(join(dir, 'entries/Edit.js'))}),\n};\n`,
    );
  });

  it('writes a path with a quote or a backslash as a string literal', () => {
    const nested = tree({ 'package.json': { name: 'app', dependencies: { 'status-board': '*' } } });
    const home = join(nested, 'a"b\\c');
    for (const [path, content] of Object.entries(statusBoard)) {
      const file = join(home, path.replace('node_modules/', ''));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    }
    mkdirSync(join(nested, 'node_modules'));
    symlinkSync(join(home, 'status-board'), join(nested, 'node_modules/status-board'), 'dir');
    const code = pagesOf(nested);
    const literal = /import\(("(?:[^"\\]|\\.)*")\)/.exec(code)![1]!;
    expect(JSON.parse(literal)).toBe(join(home, 'status-board/dist/views/Index.js'));
  });

  it('is an error for a namespace no package declares, one that is no namespace, and a package without pages', () => {
    const root = appWith({ ...statusBoard, 'node_modules/ui-kit/package.json': { name: 'ui-kit', marmeon: { namespace: 'ui-kit' } } }, { 'status-board': '*', 'ui-kit': '*' });
    const plugin = pluginFor(root);
    for (const namespace of ['nope', 'ui-kit', 'x"y', 'App', '']) {
      expect(() => call(plugin, 'resolveId', `virtual:marmeon/pages/${namespace}`)).toThrow(/no installed package declares that namespace/);
    }
    expect(() => call(plugin, 'load', '\0virtual:marmeon/pages/nope')).toThrow(/no installed package declares that namespace/);
    expect(call(plugin, 'resolveId', 'virtual:marmeon/pages')).toBeUndefined();
    expect(call(plugin, 'load', '\0virtual:marmeon/pages')).toBeUndefined();
  });

  it('checks every file again when it loads: a link swapped in after the discovery leads nowhere', () => {
    const root = appWith();
    const outside = tree({ 'Secret.js': 'export default "secret";\n' });
    const plugin = pluginFor(root);
    const id = call(plugin, 'resolveId', 'virtual:marmeon/pages/status') as string;
    const view = join(root, 'node_modules/status-board/dist/views/Index.js');
    rmSync(view);
    symlinkSync(join(outside, 'Secret.js'), view);
    expect(() => call(plugin, 'load', id)).toThrow(/lies outside the package/);
  });
});

describe('route names in the code of a package', () => {
  const code = "import { useRoute } from '@marmeon/react';\nexport const link = () => useRoute()('home');\n";
  const tracked = (root: string, directories: readonly string[]) => {
    const plugin = routesModule({ packageDirectories: () => directories });
    (plugin.configResolved as (config: unknown) => void)({ root, command: 'serve' });
    const ctx = { error(message: string): never { throw new Error(message); }, environment: { config: { consumer: 'client' } } };
    return (id: string) => (plugin.transform as (this: unknown, code: string, id: string) => { code: string } | undefined).call(ctx, code, id);
  };
  const root = appWith({
    ...statusBoard,
    'node_modules/status-board/dist/views/Page.js': code,
    'node_modules/status-board/node_modules/inner/index.js': code,
    'node_modules/other-lib/dist/Page.js': code,
    '.marmeon/routes.json': { version: 1, routes: { home: { method: 'get', path: '/' } }, hidden: {} },
  });
  const status = join(root, 'node_modules/status-board');

  it('are collected from a package that declares a namespace', () => {
    const transform = tracked(root, [status]);
    expect(transform(join(status, 'dist/views/Page.js'))?.code).toContain('__marmeonReferenceRoutes(["home"])');
  });

  it('are collected from a package that declares only a namespace and is installed below another package', () => {
    const nested = appWith({
      'node_modules/host/package.json': { name: 'host', type: 'module', exports: './index.js', dependencies: { 'ui-kit': '*' }, marmeon: { providers: [] } },
      'node_modules/host/index.js': 'export {};\n',
      'node_modules/host/node_modules/ui-kit/package.json': { name: 'ui-kit', type: 'module', exports: './dist/Page.js', marmeon: { namespace: 'ui-kit' } },
      'node_modules/host/node_modules/ui-kit/dist/Page.js': code,
      '.marmeon/routes.json': { version: 1, routes: { home: { method: 'get', path: '/' } }, hidden: {} },
    }, { host: '*' });
    const directories = uiPackages(nested, ['import']).map((surface) => surface.dir);
    expect(directories).toEqual([join(nested, 'node_modules/host/node_modules/ui-kit')]);
    const transform = tracked(nested, directories);
    expect(transform(join(directories[0]!, 'dist/Page.js'))?.code).toContain('__marmeonReferenceRoutes(["home"])');
  });

  it('are not collected from another package in node_modules, nor from one nested inside a namespace package', () => {
    const transform = tracked(root, [status]);
    expect(transform(join(root, 'node_modules/other-lib/dist/Page.js'))).toBeUndefined();
    expect(transform(join(status, 'node_modules/inner/index.js'))).toBeUndefined();
    // Nor does a package whose name merely starts like the directory.
    expect(transform(`${status}-evil/dist/Page.js`)).toBeUndefined();
    // Without a declared package, node_modules stays out as before.
    expect(tracked(root, [])(join(status, 'dist/views/Page.js'))).toBeUndefined();
  });
});

describe('codeString', () => {
  it('escapes what could end a literal or a context and reads back unchanged', () => {
    const value = '/a/</script>/b>\u2028\u2029"\\x';
    const code = codeString(value);
    expect(code).not.toMatch(/[<>\u2028\u2029]/);
    expect(JSON.parse(code)).toBe(value);
    expect(new Function(`return ${code}`)()).toBe(value);
  });
});
