import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createApplication } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { I18nServiceProvider, Translator } from './index.ts';

/** An app whose language files are `files` (path → source), booted. */
async function boot(files: Record<string, string>, env: Record<string, string> = {}) {
  const root = tempDir('marmeon-framework-texts-');
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const application = await createApplication(
    { root, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider] },
    { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env } },
  );
  return {
    application,
    text: (key: string, locale = 'en', params: Record<string, unknown> = {}) => {
      const translator: { get(key: string, params?: Record<string, unknown>): string } = application.container.createScope().make(Translator).forLocale(locale);
      return translator.get(key, params);
    },
  };
}

describe('lang/marmeon — the app rewords and translates the framework’s texts', () => {
  it('rewords a text of English; every other text stays the framework’s', async () => {
    const { text } = await boot({ 'lang/marmeon/en.ts': `export default { status: { '404': 'Nothing here' } };` });
    expect(text('marmeon.status.404')).toBe('Nothing here');
    expect(text('marmeon.status.403')).toBe('Forbidden');
    expect(text('marmeon.errors.csrf')).toBe('CSRF token mismatch.');
  });

  it('leaves German as the framework has it when the app has no file for it', async () => {
    const { text } = await boot({ 'lang/marmeon/en.ts': `export default { status: { '404': 'Nothing here' } };` }, { APP_LOCALES: 'en,de' });
    expect(text('marmeon.status.404', 'de')).toBe('Nicht gefunden');
  });

  it('rewords a text of German over the framework’s German', async () => {
    const { text } = await boot({ 'lang/marmeon/de.ts': `export default { status: { '404': 'Seite weg' } };` }, { APP_LOCALES: 'en,de' });
    expect(text('marmeon.status.404', 'de')).toBe('Seite weg');
    expect(text('marmeon.status.403', 'de')).toBe('Zugriff verweigert');
    expect(text('marmeon.status.404', 'en')).toBe('Not Found');
  });

  it('adds a language: its own texts, the rest in English — and it is supported without APP_LOCALES', async () => {
    const { text } = await boot({ 'lang/marmeon/fr.ts': `export default { status: { '404': 'Introuvable' } };` });
    expect(text('marmeon.status.404', 'fr')).toBe('Introuvable');
    expect(text('marmeon.status.403', 'fr')).toBe('Forbidden');
  });

  it('a file for a locale outside APP_LOCALES is skipped', async () => {
    const { text } = await boot({ 'lang/marmeon/fr.ts': `export default { status: { '404': 'Introuvable' } };` }, { APP_LOCALES: 'en,de' });
    expect(text('marmeon.status.404', 'fr')).toBe('Not Found');
  });

  it('fills placeholders as the framework’s own: a value is text, and so is the markup in the file', async () => {
    const { text } = await boot({ 'lang/marmeon/en.ts': `export default { validation: { max: { string: '<b>{attribute}</b>: at most {max} characters.' } } };` });
    const attribute = '<img src=x onerror=alert(1)>';
    // Nothing is parsed as markup, nothing in a value is read as a placeholder: the output is the template with the values in.
    expect(text('marmeon.validation.max.string', 'en', { max: 5, attribute })).toBe(`<b>${attribute}</b>: at most 5 characters.`);
    expect(text('marmeon.validation.max.string', 'en', { max: '{attribute}', attribute: '{max}' })).toBe('<b>{max}</b>: at most {attribute} characters.');
  });

  it('a key the framework does not have stops the start with S6', async () => {
    await expect(boot({ 'lang/marmeon/fr.ts': `export default { validation: { foo: 'x' } };` })).rejects.toThrow(
      "[marmeon:S6] lang/marmeon/fr.ts has the key validation.foo, which the framework's texts do not have.",
    );
    await expect(boot({ 'lang/marmeon/en.ts': `export default { status: 'x' };` })).rejects.toThrow(/\[marmeon:S6\] lang\/marmeon\/en\.ts has the key status, which .* \(it is a group of texts, not a text\)/);
  });

  it('an object in place of a text, or a group the framework does not have, stops the start with S6 — it never wipes a text', async () => {
    await expect(boot({ 'lang/marmeon/en.ts': `export default { status: { '404': {} } };` })).rejects.toThrow(
      "[marmeon:S6] lang/marmeon/en.ts has the key status.404, which is a text of the framework's, not a group.",
    );
    await expect(boot({ 'lang/marmeon/en.ts': `export default { validation: { required: {} } };` })).rejects.toThrow(
      "[marmeon:S6] lang/marmeon/en.ts has the key validation.required, which is a text of the framework's, not a group.",
    );
    await expect(boot({ 'lang/marmeon/en.ts': `export default { foo: {} };` })).rejects.toThrow(
      "[marmeon:S6] lang/marmeon/en.ts has the key foo, which the framework's texts do not have.",
    );
    await expect(boot({ 'lang/marmeon/en.ts': `export default { constructor: {} };` })).rejects.toThrow(
      "[marmeon:S6] lang/marmeon/en.ts has the key constructor, which the framework's texts do not have.",
    );
  });

  it('a text that drops a placeholder of the framework’s stops the start with S6', async () => {
    await expect(boot({ 'lang/marmeon/fr.ts': `export default { validation: { max: { string: 'Trop long, {max}.' } } };` })).rejects.toThrow(
      '[marmeon:S6] lang/marmeon/fr.ts drops the placeholder {attribute} of validation.max.string.',
    );
    await expect(boot({ 'lang/marmeon/fr.ts': `export default { validation: { more: '(et d’autres)' } };` })).rejects.toThrow(
      '[marmeon:S6] lang/marmeon/fr.ts drops the placeholder {count} of validation.more.',
    );
  });

  it('keeps a placeholder inside a plural, and reorders the words around it', async () => {
    const { text } = await boot({ 'lang/marmeon/fr.ts': `export default { validation: { more: '(et {count, plural, one {# autre erreur} other {# autres erreurs}})' } };` });
    expect(text('marmeon.validation.more', 'fr', { count: 2 })).toBe('(et 2 autres erreurs)');
  });

  it('a syntax error is S5', async () => {
    await expect(boot({ 'lang/marmeon/fr.ts': `export default { status: { '404': 'Introuvable {x' } };` })).rejects.toThrow(/\[marmeon:S5\] Message marmeon\.status\.404 in .*fr\.ts is malformed/);
  });

  it('a file that is no object of messages stops the start', async () => {
    await expect(boot({ 'lang/marmeon/fr.ts': `export default 'x';` })).rejects.toThrow(/must export an object of messages/);
  });

  it('files that are no language tags are left alone', async () => {
    const { text } = await boot({ 'lang/marmeon/en.test.ts': `export default { nope: 'x' };`, 'lang/marmeon/helpers_x.ts': `export default { nope: 'x' };` });
    expect(text('marmeon.status.404')).toBe('Not Found');
  });

  it('a module named marmeon is still refused', async () => {
    await expect(boot({ 'modules/marmeon/lang/en.ts': `export default { a: 'x' };` })).rejects.toThrow(/belongs to the framework/);
  });
});
