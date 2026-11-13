import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createApplication } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { I18nServiceProvider, Translator } from './index.ts';

const EN = `export default { title: 'Status', saved: 'Saved {name}.', entries: { count: '{count, plural, one {# entry} other {# entries}}' } };`;
const DE = `export default { title: 'Zustand', saved: '{name} gespeichert.' };`;
const PACKAGE_FILES = { 'dist/lang/en.js': EN, 'dist/lang/de.js': DE };

interface Setup {
  readonly files?: Record<string, string>;
  readonly packageFiles?: Record<string, string>;
  readonly marmeon?: Record<string, unknown>;
  readonly exports?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}

/** An app with the package `@acme/status-board` installed in its node_modules (namespace `status`, texts under `lang`), booted. */
async function boot({ files = {}, packageFiles = PACKAGE_FILES, marmeon = { namespace: 'status', lang: './lang' }, exports = { './lang/*': './dist/lang/*.js' }, env = {} }: Setup = {}) {
  const root = realpathSync(tempDir('marmeon-package-texts-'));
  const dir = join(root, 'node_modules', '@acme', 'status-board');
  const put = (base: string, path: string, source: string) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), source);
  };
  put(root, 'package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: { '@acme/status-board': '1.0.0' } }));
  put(dir, 'package.json', JSON.stringify({ name: '@acme/status-board', version: '1.0.0', type: 'module', exports, marmeon }));
  for (const [path, source] of Object.entries(packageFiles)) put(dir, path, source);
  for (const [path, source] of Object.entries(files)) put(root, path, source);
  const application = await createApplication(
    { root, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider] },
    { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_LOCALES: 'en,de', ...env } },
  );
  return {
    text: (key: string, locale = 'en', params: Record<string, unknown> = {}) => {
      const translator: { get(key: string, params?: Record<string, unknown>): string } = application.container.createScope().make(Translator).forLocale(locale);
      return translator.get(key, params);
    },
  };
}

describe('the texts of a package', () => {
  it('are in the catalog under the package’s namespace, in every locale it has files for', async () => {
    const { text } = await boot();
    expect(text('status.title')).toBe('Status');
    expect(text('status.saved', 'en', { name: 'A' })).toBe('Saved A.');
    expect(text('status.entries.count', 'en', { count: 2 })).toBe('2 entries');
    expect(text('status.title', 'de')).toBe('Zustand');
  });

  it('are skipped for a locale outside APP_LOCALES', async () => {
    const { text } = await boot({ env: { APP_LOCALES: 'en' } });
    expect(text('status.title', 'de')).toBe('Status');
  });

  it('are not loaded for a package that declares a namespace without texts', async () => {
    const { text } = await boot({ marmeon: { namespace: 'status' }, files: { 'modules/status/lang/en.ts': `export default { own: 'mine' };` } });
    expect(text('status.own')).toBe('mine');
  });
});

describe('lang/<namespace>/<locale>.ts — the app rewords a package’s texts key by key', () => {
  it('lays one key over the package’s, and leaves the rest and the other locales alone', async () => {
    const { text } = await boot({ files: { 'lang/status/en.ts': `export default { title: 'Health' };` } });
    expect(text('status.title')).toBe('Health');
    expect(text('status.saved', 'en', { name: 'A' })).toBe('Saved A.');
    expect(text('status.entries.count', 'en', { count: 1 })).toBe('1 entry');
    expect(text('status.title', 'de')).toBe('Zustand');
  });

  it('reaches into a group', async () => {
    const { text } = await boot({ files: { 'lang/status/en.ts': `export default { entries: { count: '{count} items' } };` } });
    expect(text('status.entries.count', 'en', { count: 3 })).toBe('3 items');
    expect(text('status.title')).toBe('Status');
  });

  it('rewords the German texts of the package in German', async () => {
    const { text } = await boot({ files: { 'lang/status/de.ts': `export default { title: 'Lage' };` } });
    expect(text('status.title', 'de')).toBe('Lage');
    expect(text('status.saved', 'de', { name: 'A' })).toBe('A gespeichert.');
    expect(text('status.title', 'en')).toBe('Status');
  });

  it('a key the package does not have stops the start with S6', async () => {
    await expect(boot({ files: { 'lang/status/en.ts': `export default { nope: 'x' };` } })).rejects.toThrow(
      '[marmeon:S6] lang/status/en.ts has the key nope, which the texts of @acme/status-board do not have.',
    );
    await expect(boot({ files: { 'lang/status/en.ts': `export default { title: {} };` } })).rejects.toThrow(
      '[marmeon:S6] lang/status/en.ts has the key title, which is a text of @acme/status-board, not a group.',
    );
    await expect(boot({ files: { 'lang/status/en.ts': `export default { entries: 'x' };` } })).rejects.toThrow(/\[marmeon:S6\] lang\/status\/en\.ts has the key entries, which .* \(it is a group of texts, not a text\)/);
  });

  it('a text that drops a placeholder of the package’s stops the start with S6', async () => {
    await expect(boot({ files: { 'lang/status/en.ts': `export default { saved: 'Saved.' };` } })).rejects.toThrow(
      '[marmeon:S6] lang/status/en.ts drops the placeholder {name} of saved.',
    );
    await expect(boot({ files: { 'lang/status/de.ts': `export default { saved: 'Gespeichert.' };` } })).rejects.toThrow(
      '[marmeon:S6] lang/status/de.ts drops the placeholder {name} of saved.',
    );
  });

  it('a syntax error is S5, and a file that is no object stops the start', async () => {
    await expect(boot({ files: { 'lang/status/en.ts': `export default { saved: 'Saved {name' };` } })).rejects.toThrow(/\[marmeon:S5\] Message status\.saved in .*en\.ts is malformed/);
    await expect(boot({ files: { 'lang/status/en.ts': `export default 'x';` } })).rejects.toThrow(/must export an object of messages/);
  });

  it('a locale the package lacks is the app’s own translation, without the placeholder check', async () => {
    const { text } = await boot({ files: { 'lang/status/fr.ts': `export default { title: 'Etat', saved: 'Enregistre.' };` }, env: { APP_LOCALES: 'en,de,fr' } });
    expect(text('status.title', 'fr')).toBe('Etat');
    expect(text('status.saved', 'fr', { name: 'A' })).toBe('Enregistre.');
    // Keys it leaves out fall back like any message's.
    expect(text('status.entries.count', 'fr', { count: 2 })).toBe('2 entries');
  });

  it('a key no file of the package has stops the start with S6, in a locale the package lacks too', async () => {
    await expect(boot({ files: { 'lang/status/fr.ts': `export default { nope: 'x' };` }, env: { APP_LOCALES: 'en,de,fr' } })).rejects.toThrow(
      '[marmeon:S6] lang/status/fr.ts has the key nope, which the texts of @acme/status-board do not have.',
    );
  });

  it('without an English file the override is checked against the file of its own locale', async () => {
    const packageFiles = { 'dist/lang/de.js': DE };
    await expect(boot({ packageFiles, files: { 'lang/status/de.ts': `export default { nope: 'x' };` } })).rejects.toThrow(/lang\/status\/de\.ts has the key nope/);
    await expect(boot({ packageFiles, files: { 'lang/status/de.ts': `export default { saved: 'Gespeichert.' };` } })).rejects.toThrow(/drops the placeholder \{name\} of saved/);
    const { text } = await boot({ packageFiles, files: { 'lang/status/de.ts': `export default { title: 'Lage' };` } });
    expect(text('status.title', 'de')).toBe('Lage');
  });

  it('without an English file, a key the locale lacks but another file has passes, and its placeholders are the app’s', async () => {
    const packageFiles = { 'dist/lang/de.js': DE, 'dist/lang/fr.js': `export default { title: 'Etat', extra: 'Plus {n}' };` };
    const { text } = await boot({ packageFiles, files: { 'lang/status/de.ts': `export default { extra: 'Mehr' };` } });
    expect(text('status.extra', 'de')).toBe('Mehr');
    expect(text('status.title', 'de')).toBe('Zustand');
  });

  it('a package whose texts have no target for the server stops the start with K7', async () => {
    await expect(boot({ exports: { './lang/*': { browser: './dist/lang/*.js' } } })).rejects.toThrow(
      '[marmeon:K7] @acme/status-board declares "lang" in its "marmeon" field, but its "exports" has no entry for that subpath with "/*" (a pattern such as "./views/*") that applies here.',
    );
  });

  it('a package whose client entry has no target for the server still loads its texts', async () => {
    const { text } = await boot({
      marmeon: { namespace: 'status', entry: { client: './area/client', ssr: './area/ssr' }, views: './views', lang: './lang' },
      exports: { './area/client': { browser: './dist/area/client.js' }, './area/ssr': './dist/area/ssr.js', './views/*': { browser: './dist/views/*.js' }, './lang/*': './dist/lang/*.js' },
      packageFiles: { ...PACKAGE_FILES, 'dist/area/ssr.js': '' },
    });
    expect(text('status.title')).toBe('Status');
  });

  it('a file for a locale outside APP_LOCALES is skipped, and files that are no language tags are left alone', async () => {
    const { text } = await boot({
      files: { 'lang/status/fr.ts': `export default { title: 'Etat' };`, 'lang/status/en.test.ts': `export default { nope: 'x' };`, 'lang/status/helpers_x.ts': `export default { nope: 'x' };` },
    });
    expect(text('status.title', 'fr')).toBe('Status');
    expect(text('status.title')).toBe('Status');
  });

  it('is defined once per locale', async () => {
    await expect(
      boot({ files: { 'lang/status/en.ts': `export default { title: 'A' };`, 'lang/status/en.js': `export default { title: 'B' };` } }),
    ).rejects.toThrow(/status messages in en are reworded twice/);
  });

  it('keeps ignoring lang/<x>/ for a namespace nobody has texts for', async () => {
    const { text } = await boot({ files: { 'lang/unknown/en.ts': `export default 'not even an object';`, 'lang/other/de.ts': `export default { a: 1 };` } });
    expect(text('status.title')).toBe('Status');
    const bare = await boot({ marmeon: { namespace: 'status' }, files: { 'lang/status/en.ts': `export default 'not even an object';` } });
    expect(bare.text('app.nothing')).toBeTypeOf('string');
  });
});

describe('a namespace both a package and a module of the app have texts for', () => {
  it('stops the start with S7', async () => {
    await expect(boot({ files: { 'modules/status/lang/en.ts': `export default { own: 'mine' };` } })).rejects.toThrow(
      /^\[marmeon:S7\] The namespace "status" has texts in @acme\/status-board and in the app's modules\/status\/lang/,
    );
  });

  it('is no error when only the package has texts, or only the module', async () => {
    const onlyPackage = await boot({ files: { 'modules/notes/lang/en.ts': `export default { own: 'mine' };` } });
    expect(onlyPackage.text('status.title')).toBe('Status');
    expect(onlyPackage.text('notes.own')).toBe('mine');
    const onlyModule = await boot({ marmeon: { namespace: 'status' }, files: { 'modules/status/lang/en.ts': `export default { own: 'mine' };` } });
    expect(onlyModule.text('status.own')).toBe('mine');
  });

  it('is no error for a module file that is no language file', async () => {
    const { text } = await boot({ files: { 'modules/status/lang/en.test.ts': 'export default {};', 'modules/status/lang/x.d.ts': '' } });
    expect(text('status.title')).toBe('Status');
  });
});
