import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { marmeon, PLUGIN_NAME } from './plugin.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function tree(files: Record<string, unknown>): string {
  const root = realpathSync(tempDir('marmeon-vite-lang-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const TEXTS = { 'dist/lang/en.js': "export default { title: 'Admin' };\n", 'dist/lang/de.js': "export default { title: 'Verwaltung' };\n" };

/** An installed package with a namespace and texts; `entry` makes it one with an entry of its own. */
function pkg(name: string, namespace: string, { entry = false, browserOnly = false }: { entry?: boolean; browserOnly?: boolean } = {}): Record<string, unknown> {
  const dir = `node_modules/${name}`;
  return {
    [`${dir}/package.json`]: {
      name,
      type: 'module',
      exports: { './lang/*': './dist/lang/*.js', ...(entry ? { './client': browserOnly ? { browser: './dist/client.js' } : './dist/client.js', './ssr': browserOnly ? { node: './dist/ssr.js' } : './dist/ssr.js', './views/*': browserOnly ? { browser: './dist/views/*.js' } : './dist/views/*.js' } : {}) },
      marmeon: { namespace, lang: './lang', ...(entry ? { entry: { client: './client', ssr: './ssr' }, views: './views' } : {}) },
    },
    ...Object.fromEntries(Object.entries(TEXTS).map(([file, source]) => [`${dir}/${file}`, source])),
    ...(entry ? { [`${dir}/dist/client.js`]: 'export {};\n', [`${dir}/dist/ssr.js`]: 'export {};\n', [`${dir}/dist/views/Index.js`]: 'export default 1;\n' } : {}),
  };
}

function appWith(packages: string[], files: Record<string, unknown>): string {
  return tree({ 'package.json': { name: 'app', private: true, type: 'module', dependencies: Object.fromEntries(packages.map((name) => [name, '*'])) }, ...files });
}

function load(root: string, id: string): { code: unknown; plugins: Plugin[] } {
  const plugins = marmeon({ test: true });
  const main = plugins.find((plugin) => plugin.name === PLUGIN_NAME)!;
  (main.config as (config: UserConfig, env: ConfigEnv) => unknown)({ root }, { command: 'serve', mode: 'development' } as ConfigEnv);
  const context = { error(message: string): never { throw new Error(message); } };
  const plugin = plugins.find((candidate) => candidate.name === (id === 'virtual:marmeon/lang' ? `${PLUGIN_NAME}:virtual-lang` : 'marmeon:package-lang'))!;
  const resolved = (plugin.resolveId as (this: unknown, source: string) => string).call(context, id);
  return { code: (plugin.load as (this: unknown, id: string) => unknown).call(context, resolved), plugins };
}

const lang = (root: string, id = 'virtual:marmeon/lang'): string => load(root, id).code as string;

describe('virtual:marmeon/lang/<namespace>', () => {
  const root = appWith(['status-board'], pkg('status-board', 'status', { entry: true }));

  it('holds the package\'s language files under the module keys createMessageLoader reads, and the app\'s lang/<namespace>/ laid over them', () => {
    const code = lang(root, 'virtual:marmeon/lang/status');
    expect(code).toContain(JSON.stringify(join(root, 'node_modules/status-board/dist/lang/en.js')));
    expect(code).toContain(JSON.stringify(join(root, 'node_modules/status-board/dist/lang/de.js')));
    expect(code).toContain('compose("status"');
    expect(code).toContain('import.meta.glob(["/lang/status/*.{js,ts}"');
  });

  it('is an error for a namespace no package declares together with an entry, and for one that is no namespace', () => {
    expect(() => lang(root, 'virtual:marmeon/lang/nope')).toThrow(/no installed package declares that namespace/);
    expect(() => lang(root, 'virtual:marmeon/lang/../x')).toThrow(/no installed package declares that namespace/);
    const without = appWith(['text-only'], pkg('text-only', 'plain'));
    expect(() => lang(without, 'virtual:marmeon/lang/plain')).toThrow(/no installed package declares that namespace/);
  });

  it('is an error for a package with an entry and no texts, whose lang/<namespace>/ the server ignores', () => {
    const bare = appWith(['status-board'], { ...pkg('status-board', 'status', { entry: true }), 'node_modules/status-board/package.json': { name: 'status-board', type: 'module', exports: { './client': './dist/client.js', './ssr': './dist/ssr.js', './views/*': './dist/views/*.js' }, marmeon: { namespace: 'status', entry: { client: './client', ssr: './ssr' }, views: './views' } }, 'lang/status/en.ts': 'export default {};\n' });
    expect(() => lang(bare, 'virtual:marmeon/lang/status')).toThrow(/no installed package declares that namespace/);
  });

  it('reads the texts of a package whose client entry, server entry and views each have a target for one side only', () => {
    const split = appWith(['status-board'], pkg('status-board', 'status', { entry: true, browserOnly: true }));
    expect(lang(split, 'virtual:marmeon/lang/status')).toContain('dist/lang/en.js');
  });
});

describe('virtual:marmeon/lang', () => {
  it('is exactly the glob of the app\'s own files without a package that has texts and no entry', () => {
    const root = appWith(['status-board'], pkg('status-board', 'status', { entry: true }));
    expect(lang(root)).toBe('export default import.meta.glob(["/modules/*/lang/*.ts","/lang/*.ts"]);\n');
    expect(lang(appWith([], {}))).toBe('export default import.meta.glob(["/modules/*/lang/*.ts","/lang/*.ts"]);\n');
  });

  it('names no path of a package with an entry', () => {
    const root = appWith(['status-board', 'text-only'], { ...pkg('status-board', 'status', { entry: true }), ...pkg('text-only', 'plain') });
    const code = lang(root);
    expect(code).not.toContain('status-board');
    expect(code).not.toContain('"status"');
    expect(code).toContain(JSON.stringify(join(root, 'node_modules/text-only/dist/lang/en.js')));
    expect(code).toContain('compose("plain"');
  });
});
