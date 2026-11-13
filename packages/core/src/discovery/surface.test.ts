import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { DiscoveryError, generateManifest, marmeonField, packageServerEntries, packageSurfaces } from './discover.ts';
import type { PackageInfo } from './resolve.ts';
import { isNamespace, isViewName } from './surface.ts';

const HOSTILE = 'hostile-value-7f3a';

const field = (marmeon: unknown): PackageInfo => ({
  name: '@acme/status-board',
  dir: '/x',
  json: { name: '@acme/status-board', marmeon } as PackageInfo['json'],
});

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as Error).message).toMatch(/^\[marmeon:K7\]/);
    return (error as Error).message;
  }
  throw new Error('expected a DiscoveryError');
}

/** The standard declaration: a compiled package with an entry, views and texts, `exports` as a package publishes them. */
const UI = { namespace: 'status', entry: { client: './area/client', ssr: './area/ssr' }, views: './views', lang: './lang' };
const EXPORTS = {
  './area/client': './dist/area/client.js',
  './area/ssr': './dist/area/ssr.js',
  './views/*': './dist/views/*.js',
  './lang/*': './dist/lang/*.js',
};

interface Layout {
  readonly marmeon?: unknown;
  readonly exports?: unknown;
  readonly files?: Record<string, string>;
}

/** An app whose node_modules holds the packages by name, laid out as an installed package is. Returns the app root. */
function appWith(packages: Record<string, Layout>): string {
  const base = realpathSync(tempDir('marmeon-surface-'));
  const root = join(base, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, '1.0.0'])) }));
  for (const [name, layout] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: layout.exports ?? EXPORTS, marmeon: layout.marmeon ?? UI }));
    for (const [file, text] of Object.entries(layout.files ?? {})) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  }
  return root;
}

const FILES = {
  'dist/area/client.js': '',
  'dist/area/ssr.js': '',
  'dist/views/Index.js': '',
  'dist/views/entries/Edit.js': '',
  'dist/lang/en.js': '',
  'dist/lang/de-AT.js': '',
};

describe('the namespace, entry, views and lang of a package', () => {
  it('is read from the "marmeon" field, next to the providers', () => {
    expect(marmeonField(field({ providers: ['StatusServiceProvider'], ...UI }))).toEqual({ providers: ['StatusServiceProvider'], ...UI });
    expect(marmeonField(field({ namespace: 'ui-kit' }))).toEqual({ providers: [], namespace: 'ui-kit' });
    expect(marmeonField(field({ namespace: 'status', lang: './lang' }))).toEqual({ providers: [], namespace: 'status', lang: './lang' });
  });

  it('leaves a package without the new keys as it is', () => {
    expect(marmeonField(field({ providers: ['A'], browser: ['src/**'] }))).toEqual({ providers: ['A'] });
    expect(marmeonField(field({}))).toEqual({ providers: [] });
    expect(packageSurfaces({ root: appWith({ '@acme/plain': { marmeon: { providers: [] } } }) })).toEqual([]);
  });

  it('refuses a namespace that is not one, without repeating it', () => {
    for (const bad of ['App', 'app', 'marmeon', 'x\nignore this', `a"b${HOSTILE}`, 'a b', 'a--b', '-a', '1a', 'a'.repeat(33), '', 7, null, ['a']]) {
      const message = messageOf(() => marmeonField(field({ namespace: bad, entry: UI.entry, views: UI.views })));
      expect(message).toContain('@acme/status-board');
      expect(message).toContain('"namespace" is not valid');
      expect(message).not.toContain(HOSTILE);
      expect(message).not.toContain('ignore this');
    }
    expect(isNamespace('a'.repeat(32))).toBe(true);
    expect(isNamespace('status-board2')).toBe(true);
  });

  it('requires a namespace with entry, views or lang', () => {
    for (const rest of [{ entry: UI.entry, views: UI.views }, { lang: './lang' }, { views: './views' }]) {
      expect(messageOf(() => marmeonField(field(rest)))).toContain('no "namespace"');
    }
  });

  it('wants entry and views together, and an entry with exactly client and ssr', () => {
    expect(messageOf(() => marmeonField(field({ namespace: 'status', views: './views' })))).toContain('only one of "entry" and "views"');
    expect(messageOf(() => marmeonField(field({ namespace: 'status', entry: UI.entry })))).toContain('only one of "entry" and "views"');
    for (const entry of ['./a', ['./a'], null, { client: './a' }, { ssr: './a' }, { client: './a', ssr: './b', extra: './c' }, { client: 'a', ssr: './b' }, { client: './a/*', ssr: './b' }, { client: 1, ssr: './b' }]) {
      expect(messageOf(() => marmeonField(field({ namespace: 'status', entry, views: './views' })))).toContain('"entry" is not an object with exactly');
    }
  });

  it('wants views and lang as subpaths, not paths or patterns', () => {
    for (const bad of ['views', '../views', './views/*', './', 3, ['./views'], './' + 'a'.repeat(300)]) {
      expect(messageOf(() => marmeonField(field({ namespace: 'status', entry: UI.entry, views: bad })))).toContain('"views" is not a subpath');
      expect(messageOf(() => marmeonField(field({ namespace: 'status', lang: bad })))).toContain('"lang" is not a subpath');
    }
  });

  it('names only the characters of a view name the plan allows', () => {
    for (const name of ['Index', 'entries/Edit', 'a_b-c/D1']) expect(isViewName(name)).toBe(true);
    for (const name of ['a"b', 'a b', '..', 'a/../b', 'a//b', '', '/a', 'a\nb', 'a.b']) expect(isViewName(name)).toBe(false);
  });
});

describe('the files a package declares, resolved', () => {
  it('lists views and texts under the patterns of its exports, and resolves the entry', () => {
    const root = appWith({ '@acme/status-board': { files: { ...FILES, 'dist/views/Index.test.js': '', 'dist/views/Index.d.ts': '', 'dist/views/Index.spec.js': '', 'dist/views/Index.type-test.js': '', 'dist/views/Index.js.map': '', 'dist/views/notes.txt': '' } } });
    const [surface] = packageSurfaces({ root, conditions: ['node', 'import'] });
    const dir = join(root, 'node_modules/@acme/status-board');
    expect(surface).toEqual({
      package: '@acme/status-board',
      namespace: 'status',
      dir,
      entry: { client: join(dir, 'dist/area/client.js') },
      views: { Index: join(dir, 'dist/views/Index.js'), 'entries/Edit': join(dir, 'dist/views/entries/Edit.js') },
      lang: { 'de-AT': join(dir, 'dist/lang/de-AT.js'), en: join(dir, 'dist/lang/en.js') },
    });
  });

  it('takes the target of the condition in force: the source in a workspace, the build when published', () => {
    const exports = {
      './area/client': { '@marmeon/source': './src/area/client.tsx', default: './dist/area/client.js' },
      './area/ssr': { '@marmeon/source': './src/area/ssr.tsx', default: './dist/area/ssr.js' },
      './views/*': { '@marmeon/source': './src/views/*.tsx', default: './dist/views/*.js' },
      './lang/*': { '@marmeon/source': './src/lang/*.ts', default: './dist/lang/*.js' },
    };
    const root = appWith({ '@acme/status-board': { exports, files: { ...FILES, 'src/views/Home.tsx': '', 'src/lang/en.ts': '', 'src/lang/en.d.ts': '' } } });
    const dir = join(root, 'node_modules/@acme/status-board');
    const source = packageSurfaces({ root, conditions: ['@marmeon/source', 'node', 'import'] })[0]!;
    expect(Object.keys(source.views)).toEqual(['Home']);
    expect(Object.keys(source.lang)).toEqual(['en']);
    expect(source.entry?.client).toBe(join(dir, 'src/area/client.tsx'));
    const built = packageSurfaces({ root, conditions: ['node', 'import'] })[0]!;
    expect(Object.keys(built.views)).toEqual(['Index', 'entries/Edit']);
  });

  it('lists nothing of a package that is not built yet, and tolerates an entry that does not exist yet', () => {
    const [surface] = packageSurfaces({ root: appWith({ '@acme/status-board': { files: {} } }) });
    expect(surface?.views).toEqual({});
    expect(surface?.lang).toEqual({});
    expect(surface?.entry?.client).toMatch(/dist\/area\/client\.js$/);
  });

  it('allows a package with a namespace alone and no entry', () => {
    const [surface] = packageSurfaces({ root: appWith({ '@acme/ui-kit': { marmeon: { namespace: 'ui-kit' } } }) });
    expect(surface).toEqual({ package: '@acme/ui-kit', namespace: 'ui-kit', dir: expect.stringMatching(/ui-kit$/), views: {}, lang: {} });
  });

  it('refuses a declared subpath the exports do not have', () => {
    const missing = (exports: unknown, marmeon: unknown = UI) => messageOf(() => packageSurfaces({ root: appWith({ '@acme/status-board': { exports, marmeon, files: FILES } }) }));
    expect(missing({ ...EXPORTS, './area/client': undefined })).toContain('no subpath for the client entry');
    expect(missing({ ...EXPORTS, './views/*': undefined })).toContain('"views"');
    expect(missing({ ...EXPORTS, './lang/*': undefined })).toContain('"lang"');
    // A target of the pattern that is not a directory and an extension:
    expect(missing({ ...EXPORTS, './views/*': './dist/views/Index.js' })).toContain('does not end in "/*"');
    expect(missing({ ...EXPORTS, './views/*': './dist/*/Index.js' })).toContain('does not end in "/*"');
    expect(missing({ ...EXPORTS, './views/*': './dist/views/*' })).toContain('does not end in "/*"');
  });

  it('refuses a target that leaves the package, naming the package and the key', () => {
    const outside = (exports: unknown) => messageOf(() => packageSurfaces({ root: appWith({ '@acme/status-board': { exports, files: FILES } }) }));
    expect(outside({ ...EXPORTS, './views/*': './../evil/*.js' })).toContain('"views" to a directory outside the package');
    expect(outside({ ...EXPORTS, './lang/*': '../../evil/*.js' })).toContain('"lang" to a directory outside the package');
    expect(outside({ ...EXPORTS, './area/client': './../evil/client.js' })).toContain('client "entry" to a file outside the package');
  });

  it('refuses a view or text that is a link leading out of the package, also through a directory', () => {
    const root = appWith({ '@acme/status-board': { files: FILES } });
    const dir = join(root, 'node_modules/@acme/status-board');
    const outside = join(dirname(root), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'Evil.js'), 'export default 1');
    symlinkSync(join(outside, 'Evil.js'), join(dir, 'dist/views/Evil.js'));
    const message = messageOf(() => packageSurfaces({ root }));
    expect(message).toContain('@acme/status-board');
    expect(message).toContain('"views"');
    expect(message).toContain('link leading out of the package');
    expect(message).not.toContain(outside);

    const lang = appWith({ '@acme/status-board': { files: FILES } });
    symlinkSync(join(outside, 'Evil.js'), join(lang, 'node_modules/@acme/status-board/dist/lang/xx.js'));
    expect(messageOf(() => packageSurfaces({ root: lang }))).toContain('"lang"');
  });

  it('refuses a views directory that is itself a link out of the package', () => {
    const root = appWith({ '@acme/status-board': { files: { 'dist/area/client.js': '', 'dist/area/ssr.js': '' } } });
    const outside = join(dirname(root), 'outside-views');
    mkdirSync(outside);
    writeFileSync(join(outside, 'Evil.js'), '');
    symlinkSync(outside, join(root, 'node_modules/@acme/status-board/dist/views'));
    expect(messageOf(() => packageSurfaces({ root }))).toContain('"views" to a directory outside the package');
  });

  it('follows a link inside the package, and does not walk a linked directory', () => {
    const root = appWith({ '@acme/status-board': { files: FILES } });
    const dir = join(root, 'node_modules/@acme/status-board');
    symlinkSync(join(dir, 'dist/views/Index.js'), join(dir, 'dist/views/Alias.js'));
    symlinkSync(join(dir, 'dist/views'), join(dir, 'dist/views/loop'));
    const [surface] = packageSurfaces({ root });
    expect(Object.keys(surface!.views)).toEqual(['Alias', 'Index', 'entries/Edit']);
  });

  it('refuses a file name that is no view name, without repeating it', () => {
    for (const name of ['a"b', 'a b', 'a;b', `a${HOSTILE}"b`, 'a.b']) {
      const root = appWith({ '@acme/status-board': { files: { ...FILES, [`dist/views/${name}.js`]: '' } } });
      const message = messageOf(() => packageSurfaces({ root }));
      expect(message).toContain('no view name');
      expect(message).not.toContain(HOSTILE);
    }
    const badLocale = appWith({ '@acme/status-board': { files: { ...FILES, 'dist/lang/not a tag.js': '' } } });
    expect(messageOf(() => packageSurfaces({ root: badLocale }))).toContain('no language tag');
  });

  it('refuses more than 1000 views and 100 texts', () => {
    const many = (folder: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`dist/${folder}/F${index}.js`, '']));
    const views = appWith({ '@acme/status-board': { files: { ...FILES, ...many('views', 1000) } } });
    expect(messageOf(() => packageSurfaces({ root: views }))).toContain('more than 1000 files in its "views"');
    const fine = appWith({ '@acme/status-board': { files: { 'dist/area/client.js': '', 'dist/area/ssr.js': '', ...many('views', 1000) } } });
    expect(Object.keys(packageSurfaces({ root: fine })[0]!.views)).toHaveLength(1000);
    const lang = appWith({ '@acme/status-board': { files: { ...FILES, ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`dist/lang/x${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}.js`, ''])) } } });
    expect(messageOf(() => packageSurfaces({ root: lang }))).toContain('more than 100 files in its "lang"');
  });

  it('refuses two packages with one namespace, naming both, in discovery and at the manifest', () => {
    const root = appWith({ '@acme/status-board': { files: FILES }, '@acme/status-clone': { files: FILES } });
    for (const run of [() => packageSurfaces({ root }), () => generateManifest({ root })]) {
      const message = messageOf(run);
      expect(message).toContain('@acme/status-board');
      expect(message).toContain('@acme/status-clone');
      expect(message).toContain('namespace "status"');
    }
  });

  it('lets two packages with different namespaces coexist, in dependency order', () => {
    const root = appWith({ '@acme/status-board': { files: FILES }, '@acme/audit-ui': { marmeon: { namespace: 'audit' } } });
    expect(packageSurfaces({ root }).map((surface) => surface.namespace).sort()).toEqual(['audit', 'status']);
  });
});

describe('what discovery refuses instead of passing over', () => {
  it('refuses two copies of one package that declare one namespace, and accepts one package reached twice', () => {
    const root = appWith({ '@acme/status-board': { files: FILES } });
    const nested = join(root, 'node_modules/@acme/other/node_modules/@acme/status-board');
    mkdirSync(dirname(nested), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@acme/status-board', version: '2.0.0', exports: EXPORTS, marmeon: UI }));
    writeFileSync(join(root, 'node_modules/@acme/other/package.json'), JSON.stringify({ name: '@acme/other', version: '1.0.0', dependencies: { '@acme/status-board': '2.0.0' } }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: { '@acme/status-board': '1.0.0', '@acme/other': '1.0.0' } }));
    for (const run of [() => packageSurfaces({ root }), () => generateManifest({ root })]) {
      const message = messageOf(run);
      expect(message).toContain('@acme/status-board is installed twice');
      expect(message).toContain('namespace "status"');
    }

    const linked = appWith({ '@acme/status-board': { files: FILES } });
    const target = join(linked, 'node_modules/@acme/status-board');
    symlinkSync(target, join(linked, 'node_modules/status-alias'));
    writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: { '@acme/status-board': '1.0.0', 'status-alias': '1.0.0' } }));
    expect(packageSurfaces({ root: linked })).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder under views that cannot be read, instead of listing the rest', () => {
    const root = appWith({ '@acme/status-board': { files: FILES } });
    const folder = join(root, 'node_modules/@acme/status-board/dist/views/entries');
    onTestFinished(() => chmodSync(folder, 0o755));
    chmodSync(folder, 0o000);
    const message = messageOf(() => packageSurfaces({ root }));
    expect(message).toContain('"views" directory that cannot be read');
    expect(message).not.toContain(folder);
  });

  it('refuses views nested deeper than 16 levels, and lists 16', () => {
    const at = (levels: number) => ({ [`dist/views/${Array.from({ length: levels }, (_, index) => `d${index}`).join('/')}/V.js`]: '' });
    const deep = appWith({ '@acme/status-board': { files: { ...FILES, ...at(17) } } });
    expect(messageOf(() => packageSurfaces({ root: deep }))).toContain('deeper than 16 levels');
    const fine = appWith({ '@acme/status-board': { files: { ...FILES, ...at(16) } } });
    expect(Object.keys(packageSurfaces({ root: fine })[0]!.views)).toHaveLength(3);
  });

  it('refuses a pattern whose target is the package root itself, saying the target must be a folder below it', () => {
    const root = appWith({ '@acme/status-board': { exports: { ...EXPORTS, './lang/*': './*.js' }, files: FILES } });
    expect(messageOf(() => packageSurfaces({ root }))).toContain('must be a folder below the package root');
  });
});

describe('what the raw declaration and the real path must not hide', () => {
  it('validates the declared surface when the manifest is generated', () => {
    const root = appWith({ '@acme/ui-kit': { marmeon: { namespace: 'status', lang: './lang' }, exports: { '.': './dist/index.js' } } });
    const message = messageOf(() => generateManifest({ root }));
    expect(message).toContain('@acme/ui-kit');
    expect(message).toContain('"lang"');
    const browserOnly = appWith({ '@acme/status-board': { exports: { ...EXPORTS, './area/client': { browser: './dist/area/client.js' } }, files: FILES } });
    expect(() => generateManifest({ root: browserOnly })).not.toThrow();
    const fine = appWith({ '@acme/status-board': { files: FILES } });
    expect(() => generateManifest({ root: fine })).not.toThrow();
  });

  it('refuses an exports target with a dot, dot-dot or node_modules segment, as Node does', () => {
    const refused = (exports: unknown) => messageOf(() => packageSurfaces({ root: appWith({ '@acme/status-board': { exports, files: FILES } }) }));
    expect(refused({ ...EXPORTS, './views/*': './dist/../dist/views/*.js' })).toContain('segment');
    expect(refused({ ...EXPORTS, './lang/*': './dist/./lang/*.js' })).toContain('segment');
    expect(refused({ ...EXPORTS, './views/*': './dist//views/*.js' })).toContain('segment');
    expect(refused({ ...EXPORTS, './area/client': './dist/../dist/area/client.js' })).toContain('segment');
  });

  it('refuses a view that is a link into the package\'s own node_modules, and a linked pattern directory', () => {
    const root = appWith({ '@acme/status-board': { files: FILES } });
    const dir = join(root, 'node_modules/@acme/status-board');
    mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/dep/View.js'), '');
    symlinkSync(join(dir, 'node_modules/dep/View.js'), join(dir, 'dist/views/Alias.js'));
    expect(messageOf(() => packageSurfaces({ root }))).toContain('link leading out of the package');

    const linkedDirectory = appWith({ '@acme/status-board': { files: { 'dist/area/client.js': '', 'dist/area/ssr.js': '' } } });
    const other = join(linkedDirectory, 'node_modules/@acme/status-board');
    mkdirSync(join(other, 'node_modules/dep/views'), { recursive: true });
    symlinkSync(join(other, 'node_modules/dep/views'), join(other, 'dist/views'));
    expect(messageOf(() => packageSurfaces({ root: linkedDirectory }))).toContain('"views" to a directory outside the package');
  });
});

describe('the server entry of a package', () => {
  const ssr = { './area/ssr': { browser: './dist/area/ssr-browser.js', node: './dist/area/ssr-node.js' } };
  const files = { ...FILES, 'dist/area/ssr-browser.js': '', 'dist/area/ssr-node.js': '' };

  it('is the one the server\'s conditions name, whatever the rest of the package maps for the browser alone', () => {
    // A client entry, views and texts that only the browser has a target for: `packageSurfaces` refuses them under server conditions.
    const exports = { './area/client': { browser: './dist/area/client.js' }, './views/*': { browser: './dist/views/*.js' }, './lang/*': { browser: './dist/lang/*.js' }, ...ssr };
    const root = appWith({ '@acme/status-board': { exports, files } });
    const entries = packageServerEntries({ root, conditions: ['node', 'import'] });
    expect([...entries]).toEqual([['status', join(root, 'node_modules/@acme/status-board/dist/area/ssr-node.js')]]);
    // The surface itself is read with the client's conditions and names no server entry.
    expect(packageSurfaces({ root, conditions: ['browser', 'import'] })[0]!.entry).toEqual({ client: join(root, 'node_modules/@acme/status-board/dist/area/client.js') });
  });

  it('is refused for a raw ".." segment, a target outside the package, and a subpath without a target', () => {
    const refuse = (exports: unknown) => messageOf(() => packageServerEntries({ root: appWith({ '@acme/status-board': { exports, files } }), conditions: ['node', 'import'] }));
    expect(refuse({ ...EXPORTS, './area/ssr': './dist/../dist/area/ssr.js' })).toContain('"." or ".." or "node_modules" segment');
    expect(refuse({ ...EXPORTS, './area/ssr': './../evil/ssr.js' })).toContain('ssr "entry" to a file outside the package');
    expect(refuse({ ...EXPORTS, './area/ssr': { browser: './dist/area/ssr.js' } })).toContain('no subpath for the ssr entry that applies here');
    expect(refuse({ ...EXPORTS, './area/ssr': './dist/./area/ssr.js' })).toContain('segment');
    expect(refuse({ ...EXPORTS, './area/ssr': undefined })).toContain('no subpath for the ssr entry');
    expect(refuse({ ...EXPORTS, './area/ssr': '/etc/passwd' })).toContain('ssr "entry" to a file outside the package');
    expect(refuse({ ...EXPORTS, './area/ssr': './node_modules/x/ssr.js' })).toContain('ssr "entry" to a file outside the package');
  });

  it('may exist under the node condition alone: the client\'s reading of the package accepts that', () => {
    const exports = { ...EXPORTS, './area/ssr': { node: './dist/area/ssr.js' } };
    const root = appWith({ '@acme/status-board': { exports, files: FILES } });
    expect(packageSurfaces({ root, conditions: ['browser', 'import'] })[0]!.namespace).toBe('status');
    expect([...packageServerEntries({ root, conditions: ['node', 'import'] }).keys()]).toEqual(['status']);
  });

  it('is left out for a package without an entry', () => {
    const root = appWith({ '@acme/kit': { marmeon: { namespace: 'kit' } }, '@acme/status-board': { exports: { ...EXPORTS, ...ssr }, files } });
    expect([...packageServerEntries({ root, conditions: ['node', 'import'] }).keys()]).toEqual(['status']);
  });
});
