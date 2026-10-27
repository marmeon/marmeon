import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application, ServiceProviderClass } from '@marmeon/core';
import { stubHash } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { DE, EN, installLangPackage } from '../__fixtures__/lang-packages.ts';
import { PublishCommand } from './publish.ts';

const FILES = { 'stubs/lang/en.ts': EN, 'stubs/lang/de.ts': DE };

/** An app with `@marmeon/i18n` installed and listed. */
function makeApp(files: Record<string, string> = FILES): { root: string; providers: ServiceProviderClass[] } {
  const root = tempDir('marmeon-publish-lang-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  const { Provider } = installLangPackage(root, '@marmeon/i18n', files);
  return { root, providers: [Provider] };
}

function fakePrompt(interactive: boolean, pick: (choices: readonly string[]) => number[] = () => []) {
  const asked: { question: string; choices: readonly string[] }[] = [];
  return {
    asked,
    interactive,
    async choose(question: string, choices: readonly string[]) {
      if (!interactive) throw new Error('Cannot ask a question');
      asked.push({ question, choices });
      return pick(choices);
    },
  };
}

async function publish(app: { root: string; providers: ServiceProviderClass[] }, args: string[] = ['@marmeon/i18n'], options: Record<string, unknown> = { only: 'lang' }, prompt = fakePrompt(false)) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const command = new PublishCommand({ root: app.root, providers: app.providers } as unknown as Application);
  const code = await command.handle({ root: app.root, args, options, output, prompt } as unknown as CommandInput);
  return { code, lines };
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const manifest = (root: string) => JSON.parse(read(root, 'marmeon-stubs.json'));

describe('publish --only=lang', () => {
  it('writes the language files and records them with their hashes', async () => {
    const app = makeApp();
    const { code, lines } = await publish(app);
    expect(code).toBe(0);
    expect(read(app.root, 'lang/marmeon/en.ts')).toBe(EN);
    expect(read(app.root, 'lang/marmeon/de.ts')).toBe(DE);
    expect(manifest(app.root).sets['@marmeon/i18n:stubs/lang']).toEqual({
      package: '@marmeon/i18n',
      version: '1.2.3',
      files: {
        'lang/marmeon/de.ts': { stub: 'stubs/lang/de.ts', sha256: stubHash(DE) },
        'lang/marmeon/en.ts': { stub: 'stubs/lang/en.ts', sha256: stubHash(EN) },
      },
    });
    expect(lines).toContain('✓ Created lang/marmeon/en.ts');
  });

  it('skips what is there on the next run, with exit code 0 and every file as it was', async () => {
    const app = makeApp();
    await publish(app);
    const before = read(app.root, 'marmeon-stubs.json');
    const { code, lines } = await publish(app);
    expect(code).toBe(0);
    expect(lines).toContain('lang/marmeon/en.ts is there — skipped (yours since @marmeon/i18n 1.2.3)');
    expect(lines.at(-1)).toBe('✓ Nothing to publish — every language file of @marmeon/i18n is in your app');
    expect(read(app.root, 'marmeon-stubs.json')).toBe(before);
    expect(read(app.root, 'lang/marmeon/en.ts')).toBe(EN);
  });

  it('leaves a file the app changed, and replaces it with --force', async () => {
    const app = makeApp();
    await publish(app);
    writeFileSync(join(app.root, 'lang/marmeon/en.ts'), "export default { status: { '404': 'Mine' } };\n");
    const kept = await publish(app);
    expect(kept.code).toBe(0);
    expect(read(app.root, 'lang/marmeon/en.ts')).toContain('Mine');
    const forced = await publish(app, ['@marmeon/i18n'], { only: 'lang', force: true });
    expect(forced.code).toBe(0);
    expect(forced.lines).toContain('✓ Replaced lang/marmeon/en.ts');
    expect(read(app.root, 'lang/marmeon/en.ts')).toBe(EN);
  });

  it('says "yours" for a file the manifest does not know', async () => {
    const app = makeApp();
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    writeFileSync(join(app.root, 'lang/marmeon/en.ts'), 'export default {};\n');
    const { lines } = await publish(app);
    expect(lines).toContain('lang/marmeon/en.ts is there — skipped (yours)');
    expect(read(app.root, 'lang/marmeon/en.ts')).toBe('export default {};\n');
    expect(read(app.root, 'lang/marmeon/de.ts')).toBe(DE);
  });

  it('keeps the files recorded before in the set when it adds one', async () => {
    const app = makeApp();
    await publish(app);
    rmSync(join(app.root, 'lang/marmeon/de.ts'));
    await publish(app);
    expect(Object.keys(manifest(app.root).sets['@marmeon/i18n:stubs/lang'].files)).toEqual(['lang/marmeon/de.ts', 'lang/marmeon/en.ts']);
  });

  it('refuses a lang/marmeon that is a link out of the project, and writes nothing', async () => {
    const app = makeApp();
    const outside = tempDir('marmeon-publish-lang-outside-');
    mkdirSync(join(app.root, 'lang'));
    symlinkSync(outside, join(app.root, 'lang/marmeon'));
    const { code, lines } = await publish(app);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('leads out of the project');
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(app.root, 'marmeon-stubs.json'))).toBe(false);
  });

  it('refuses a lang/marmeon that is a link inside the project: it must be a real directory', async () => {
    const app = makeApp();
    mkdirSync(join(app.root, 'lang'));
    mkdirSync(join(app.root, 'elsewhere'));
    symlinkSync(join(app.root, 'elsewhere'), join(app.root, 'lang/marmeon'));
    const { code, lines } = await publish(app);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('lang/marmeon is not a directory');
    expect(readdirSync(join(app.root, 'elsewhere'))).toEqual([]);
  });

  it('refuses a lang that is a link out of the project, and writes nothing', async () => {
    const app = makeApp();
    const outside = tempDir('marmeon-publish-lang-outside-');
    symlinkSync(outside, join(app.root, 'lang'));
    const { code } = await publish(app);
    expect(code).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses --force on a file that is a link, and does not write through it', async () => {
    const app = makeApp();
    const outside = tempDir('marmeon-publish-lang-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'KEEP');
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    symlinkSync(join(outside, 'secret.ts'), join(app.root, 'lang/marmeon/en.ts'));
    const { code } = await publish(app, ['@marmeon/i18n'], { only: 'lang', force: true });
    expect(code).toBe(1);
    expect(readFileSync(join(outside, 'secret.ts'), 'utf8')).toBe('KEEP');
    // Refused before the first write: German was not written either.
    expect(existsSync(join(app.root, 'lang/marmeon/de.ts'))).toBe(false);
  });

  it('refuses --force on a file that is a link to a file inside the project, and leaves both as they were', async () => {
    const app = makeApp();
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    writeFileSync(join(app.root, 'lang/marmeon/mine.ts'), 'KEEP');
    symlinkSync(join(app.root, 'lang/marmeon/mine.ts'), join(app.root, 'lang/marmeon/en.ts'));
    const { code, lines } = await publish(app, ['@marmeon/i18n'], { only: 'lang', force: true });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('lang/marmeon/en.ts is a link, a hard link or no regular file');
    expect(read(app.root, 'lang/marmeon/mine.ts')).toBe('KEEP');
    expect(existsSync(join(app.root, 'lang/marmeon/de.ts'))).toBe(false);
  });

  it('refuses --force on a hard link, which could be a file outside the project', async () => {
    const app = makeApp();
    const outside = tempDir('marmeon-publish-lang-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'KEEP');
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    linkSync(join(outside, 'secret.ts'), join(app.root, 'lang/marmeon/en.ts'));
    const { code } = await publish(app, ['@marmeon/i18n'], { only: 'lang', force: true });
    expect(code).toBe(1);
    expect(readFileSync(join(outside, 'secret.ts'), 'utf8')).toBe('KEEP');
  });

  it('keeps the hash a file was written with when a later run records another file', async () => {
    const app = makeApp();
    await publish(app);
    writeFileSync(join(app.root, 'lang/marmeon/en.ts'), "export default { status: { '404': 'Mine' } };\n");
    rmSync(join(app.root, 'lang/marmeon/de.ts'));
    await publish(app);
    const files = manifest(app.root).sets['@marmeon/i18n:stubs/lang'].files;
    expect(files['lang/marmeon/en.ts'].sha256).toBe(stubHash(EN));
    expect(files['lang/marmeon/de.ts'].sha256).toBe(stubHash(DE));
  });

  it('refuses a link out of the project at the target also without --force, and does not write through it', async () => {
    const app = makeApp();
    const outside = tempDir('marmeon-publish-lang-outside-');
    writeFileSync(join(outside, 'secret.ts'), 'KEEP');
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    symlinkSync(join(outside, 'secret.ts'), join(app.root, 'lang/marmeon/en.ts'));
    const { code } = await publish(app);
    expect(code).toBe(1);
    expect(readFileSync(join(outside, 'secret.ts'), 'utf8')).toBe('KEEP');
    expect(existsSync(join(app.root, 'lang/marmeon/de.ts'))).toBe(false);
  });

  it('writes nothing when marmeon-stubs.json is of a newer format', async () => {
    const app = makeApp();
    writeFileSync(join(app.root, 'marmeon-stubs.json'), JSON.stringify({ format: 2, sets: {} }));
    const { code, lines } = await publish(app);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('newer Marmeon');
    expect(existsSync(join(app.root, 'lang'))).toBe(false);
  });

  it('writes nothing for a package that is not @marmeon/i18n, and says so', async () => {
    const root = tempDir('marmeon-publish-lang-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    const { Provider } = installLangPackage(root, '@acme/texts', FILES);
    const { code, lines } = await publish({ root, providers: [Provider] }, ['@acme/texts']);
    expect(code).toBe(1);
    expect(lines).toContain("! \"@acme/texts\" declares language files, but only the framework's texts (@marmeon/i18n) can be published — ignored.");
    expect(existsSync(join(root, 'lang'))).toBe(false);
    expect(existsSync(join(root, 'marmeon-stubs.json'))).toBe(false);
  });

  it('refuses a package that is no dependency, or declares no files', async () => {
    const app = makeApp();
    expect((await publish(app, ['@acme/other'])).lines).toContain('✗ @acme/other is not a dependency of your app — add it first.');
    const root = tempDir('marmeon-publish-lang-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/plain': '1.0.0' } }));
    mkdirSync(join(root, 'node_modules/@acme/plain'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@acme/plain/package.json'), JSON.stringify({ name: '@acme/plain' }));
    const plain = await publish({ root, providers: [] }, ['@acme/plain']);
    expect(plain.code).toBe(1);
    expect(plain.lines).toContain('✗ "@acme/plain" ships no language files.');
  });

  it('names D25 for a declaration that cannot be read, and writes nothing', async () => {
    const app = makeApp({ 'stubs/lang/en.ts': EN, 'stubs/lang/notes.ts': 'export default {};\n' });
    const { code, lines } = await publish(app);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('D25');
    expect(existsSync(join(app.root, 'lang'))).toBe(false);
  });
});

describe('publish --only: the options', () => {
  it('refuses --check with lang, an unknown kind, an empty list, --force without lang and --module without migrations', async () => {
    const app = makeApp();
    await expect(publish(app, [], { only: 'lang', check: true })).rejects.toThrow('--check covers migrations: the language files you published are yours.');
    await expect(publish(app, ['@marmeon/i18n'], { only: 'views' })).rejects.toThrow('--only knows migrations and lang, not "views"');
    await expect(publish(app, ['@marmeon/i18n'], { only: '' })).rejects.toThrow('--only knows');
    await expect(publish(app, ['@marmeon/i18n'], { only: 'lang,' })).rejects.toThrow('--only knows');
    await expect(publish(app, ['@marmeon/i18n'], { force: true })).rejects.toThrow('--force belongs to language files');
    await expect(publish(app, ['@marmeon/i18n'], { only: 'lang', module: 'texts' })).rejects.toThrow('--module belongs to migrations');
    expect(existsSync(join(app.root, 'lang'))).toBe(false);
  });

  it('keeps the migrations as the default: no --only reads no language files and writes none', async () => {
    const app = makeApp();
    const { code, lines } = await publish(app, ['@marmeon/i18n'], {});
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @marmeon/i18n ships no migrations.']);
    expect(existsSync(join(app.root, 'lang'))).toBe(false);
  });

  it('skips the kind a named package does not ship with --only=migrations,lang', async () => {
    const app = makeApp();
    const { code, lines } = await publish(app, ['@marmeon/i18n'], { only: 'migrations,lang' });
    expect(code).toBe(0);
    expect(lines).toContain('✓ Created lang/marmeon/en.ts');
    expect(lines.join('\n')).not.toContain('ships no migrations');
  });

  it('publishes the migrations of a package without language files with --only=migrations,lang, and says nothing about the missing kind', async () => {
    const root = tempDir('marmeon-publish-lang-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    const { Provider, dir } = installLangPackage(root, '@acme/things', { 'stubs/migrations/2026_01_01_000000_create_things_table.ts': 'export default {};\n' }, { publishes: () => undefined });
    (Provider as unknown as { migrations: unknown }).migrations = { from: pathToFileURL(join(realpathSync(dir), 'stubs/migrations')), module: 'things' };
    const { code, lines } = await publish({ root, providers: [Provider] }, ['@acme/things'], { only: 'migrations,lang' });
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('✗'))).toEqual([]);
    expect(readdirSync(join(root, 'modules/things/migrations'))).toHaveLength(1);
    expect(existsSync(join(root, 'lang'))).toBe(false);
  });

  it('is an error to ship neither kind with --only=migrations,lang', async () => {
    const root = tempDir('marmeon-publish-lang-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/plain': '1.0.0' } }));
    mkdirSync(join(root, 'node_modules/@acme/plain'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@acme/plain/package.json'), JSON.stringify({ name: '@acme/plain' }));
    const { code, lines } = await publish({ root, providers: [] }, ['@acme/plain'], { only: 'migrations,lang' });
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ "@acme/plain" ships neither migrations nor language files.']);
  });

  it('says "Nothing to publish" once, after the language files, for both kinds without a package', async () => {
    const app = makeApp();
    await publish(app);
    const { code, lines } = await publish(app, [], { only: 'migrations,lang' });
    expect(code).toBe(0);
    expect(lines).toEqual(['@marmeon/i18n — published (2)', '✓ Nothing to publish']);
    const missing = makeApp();
    const open = await publish(missing, [], { only: 'migrations,lang' });
    expect(open.code).toBe(1);
    expect(open.lines).toEqual(['@marmeon/i18n — not published (2)', '✗ Choose on a terminal, or run marmeon publish <package> --only=lang for each of them']);
  });
});

describe('publish --only=lang without a package', () => {
  it('lists the packages with language files and ends with exit code 1 without a terminal while something is missing', async () => {
    const app = makeApp();
    const { code, lines } = await publish(app, [], { only: 'lang' });
    expect(code).toBe(1);
    expect(lines).toEqual(['@marmeon/i18n — not published (2)', '✗ Choose on a terminal, or run marmeon publish <package> --only=lang for each of them']);
    expect(existsSync(join(app.root, 'lang'))).toBe(false);
  });

  it('shows "partly" and then "published", and ends with 0 once nothing is missing', async () => {
    const app = makeApp();
    mkdirSync(join(app.root, 'lang/marmeon'), { recursive: true });
    writeFileSync(join(app.root, 'lang/marmeon/en.ts'), 'export default {};\n');
    expect((await publish(app, [], { only: 'lang' })).lines[0]).toBe('@marmeon/i18n — partly (1 of 2)');
    await publish(app);
    const done = await publish(app, [], { only: 'lang' });
    expect(done.code).toBe(0);
    expect(done.lines).toEqual(['@marmeon/i18n — published (2)', '✓ Nothing to publish']);
  });

  it('asks at a terminal and publishes what is picked', async () => {
    const app = makeApp();
    const prompt = fakePrompt(true, () => [0]);
    const { code } = await publish(app, [], { only: 'lang' }, prompt);
    expect(code).toBe(0);
    expect(prompt.asked[0]!.choices).toEqual(['@marmeon/i18n — not published (2)']);
    expect(read(app.root, 'lang/marmeon/de.ts')).toBe(DE);
  });
});
