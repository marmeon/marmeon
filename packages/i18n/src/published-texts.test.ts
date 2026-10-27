import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import frameworkDe from './lang/de.ts';
import frameworkEn from './lang/en.ts';
import { I18nServiceProvider } from './index.ts';

const stubs = fileURLToPath(new URL('../stubs/lang/', import.meta.url));
const stub = async (locale: string): Promise<unknown> => ((await import(pathToFileURL(`${stubs}${locale}.ts`).href)) as { default: unknown }).default;

describe('the language files `publish --only=lang` copies', () => {
  it('declares them on the service provider, in a directory that holds exactly English and German', () => {
    expect(fileURLToPath(I18nServiceProvider.publishes.lang)).toBe(stubs.replace(/\/$/, ''));
    expect(readdirSync(stubs).sort()).toEqual(['de.ts', 'en.ts']);
  });

  it('English is the framework’s English, text for text', async () => {
    expect(await stub('en')).toEqual(frameworkEn);
  });

  it('German is the framework’s German, text for text', async () => {
    expect(await stub('de')).toEqual(frameworkDe);
  });
});
