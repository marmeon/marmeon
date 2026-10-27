import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { DE, EN, installLangPackage } from './__fixtures__/lang-packages.ts';
import { assignPublishes, publishDeclarations, type PublishingPackage } from './package-files.ts';

/** Lists the provider, so that a declaration which cannot be read is given to this package. */
const LISTS = { marmeon: { providers: ['provider'] } };
const FILES = { 'stubs/lang/en.ts': EN, 'stubs/lang/de.ts': DE };

/** Installs the package in a fresh app and reads what it declares. */
async function read(files: Record<string, string>, extra: Parameters<typeof installLangPackage>[3] = {}, name = '@marmeon/i18n') {
  const root = tempDir('marmeon-package-files-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  const { dir, Provider } = installLangPackage(root, name, files, extra);
  const pkg: PublishingPackage & { name: string } = { name, dir, json: { name: (extra.json?.name as string | undefined) ?? name, exports: './index.js', marmeon: extra.json?.marmeon } };
  const { results, warnings } = await assignPublishes([pkg], publishDeclarations([Provider]));
  return { result: results.get(pkg)!, warnings, root, dir };
}

const message = (result: Awaited<ReturnType<typeof read>>['result']) => (result.ok ? undefined : result.error.message);

describe('the files a package publishes', () => {
  it('reads the language files, sorted, with their contents', async () => {
    const { result, warnings } = await read(FILES);
    expect(warnings).toEqual([]);
    expect(result.ok && result.value).toEqual({
      from: 'stubs/lang',
      files: [
        { name: 'de.ts', file: 'stubs/lang/de.ts', contents: DE },
        { name: 'en.ts', file: 'stubs/lang/en.ts', contents: EN },
      ],
    });
  });

  it('takes language tags with a region as names', async () => {
    const { result } = await read({ 'stubs/lang/pt-BR.ts': EN, 'stubs/lang/zh-Hant-TW.ts': EN });
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['pt-BR.ts', 'zh-Hant-TW.ts']);
  });

  it('passes over a directory outside the package: nothing is read from it', async () => {
    const outside = tempDir('marmeon-package-files-outside-');
    writeFileSync(join(outside, 'en.ts'), EN);
    const { result, warnings } = await read(FILES, { publishes: () => ({ lang: pathToFileURL(outside) }) });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('refuses a directory that is a link leading out of the package (D25)', async () => {
    const outside = tempDir('marmeon-package-files-outside-');
    writeFileSync(join(outside, 'en.ts'), EN);
    const { result } = await read({ 'README.md': 'x' }, {
      publishes: (dir) => {
        mkdirSync(join(dir, 'stubs'), { recursive: true });
        symlinkSync(outside, join(dir, 'stubs/lang'));
        return { lang: pathToFileURL(join(dir, 'stubs/lang')) };
      },
    });
    expect(message(result)).toContain('D25');
    expect(message(result)).toContain('leads out of the package');
  });

  it('refuses the package itself as the directory (D25)', async () => {
    const { result } = await read({ 'en.ts': EN }, { publishes: (dir) => ({ lang: pathToFileURL(dir) }) });
    expect(message(result)).toContain('D25');
    expect(message(result)).toContain('is the package itself');
  });

  it('refuses a file that is a link out of the package (D25)', async () => {
    const outside = tempDir('marmeon-package-files-outside-');
    writeFileSync(join(outside, 'en.ts'), EN);
    const { result } = await read(
      { 'stubs/lang/de.ts': DE },
      {
        publishes: (dir) => {
          symlinkSync(join(outside, 'en.ts'), join(dir, 'stubs/lang/en.ts'));
          return { lang: pathToFileURL(join(dir, 'stubs/lang')) };
        },
      },
    );
    expect(message(result)).toContain('D25');
    expect(message(result)).toContain('stubs/lang/en.ts');
    expect(message(result)).toContain('leads out of the package');
  });

  it.each(['notes.ts', 'e1.ts', 'en.d.ts', 'e.ts', 'en-.ts'])('refuses the file name %s (D25)', async (name) => {
    const { result } = await read({ 'stubs/lang/en.ts': EN, [`stubs/lang/${name}`]: EN });
    expect(message(result)).toContain('D25');
    expect(message(result)).toContain('must be named after a language');
  });

  it('refuses more than 100 files (D25)', async () => {
    const files = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`stubs/lang/a${String.fromCharCode(97 + (index % 26))}-${String(index).padStart(3, '0')}.ts`, EN]));
    const { result } = await read(files);
    expect(message(result)).toContain('D25');
    expect(message(result)).toContain('more than 100');
  });

  it('refuses a file without a default export or too large, and a directory without files (D25)', async () => {
    expect(message((await read({ 'stubs/lang/en.ts': 'const a = 1;\n' })).result)).toContain('has no default export');
    expect(message((await read({ 'stubs/lang/en.ts': `export default {}; // ${'x'.repeat(1 << 20)}` })).result)).toContain('larger than');
    expect(message((await read({ 'stubs/lang/readme.md': 'x' })).result)).toContain('holds no language file');
  });

  it('refuses a declaration that is no object with a file: URL for lang, or has other keys (D25)', async () => {
    expect(message((await read(FILES, { publishes: () => 'stubs/lang', json: LISTS })).result)).toContain('must be an object');
    expect(message((await read(FILES, { publishes: () => ({ lang: 'stubs/lang' }), json: LISTS })).result)).toContain('lang must be a file: URL');
    expect(message((await read(FILES, { publishes: (dir) => ({ lang: new URL(`${pathToFileURL(join(dir, 'stubs/lang')).href}?x=1`) }), json: LISTS })).result)).toContain('without a host, a query or a fragment');
    expect(message((await read(FILES, { publishes: (dir) => ({ lang: pathToFileURL(join(dir, 'stubs/lang')), views: pathToFileURL(dir) }), json: LISTS })).result)).toContain('unknown key "views"');
  });

  it('does not give a foreign provider the directory of the package: only a provider the package exports claims it', async () => {
    const root = tempDir('marmeon-package-files-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    const { dir } = installLangPackage(root, '@marmeon/i18n', FILES);
    const Foreign = class {
      static publishes = { lang: pathToFileURL(join(dir, 'stubs/lang')) };
    };
    Object.defineProperty(Foreign, 'name', { value: 'ForeignServiceProvider' });
    const pkg: PublishingPackage & { name: string } = { name: '@marmeon/i18n', dir, json: { name: '@marmeon/i18n', exports: './index.js' } };
    const { results, warnings } = await assignPublishes([pkg], publishDeclarations([Foreign as never]));
    const result = results.get(pkg)!;
    expect(result.ok && result.value).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('which does not claim them');
  });

  it('ignores a package that is not @marmeon/i18n, with a warning (nothing is read)', async () => {
    const { result, warnings } = await read(FILES, {}, '@acme/texts');
    expect(result.ok && result.value).toBeUndefined();
    expect(warnings).toEqual(["\"@acme/texts\" declares language files, but only the framework's texts (@marmeon/i18n) can be published — ignored."]);
  });

  it('does not take an alias for the framework: the name in the package.json counts, not the one the app lists', async () => {
    const { result, warnings } = await read(FILES, { json: { name: '@acme/texts' } });
    expect(result.ok && result.value).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('only the framework');
  });
});
