import { ValidationError } from '@marmeon/router';
import { rules as r, VALIDATION_TEXTS } from '@marmeon/validation';
import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog.ts';
import frameworkDe from './lang/de.ts';
import frameworkEn from './lang/en.ts';
import { createTranslator } from './translator.ts';

/** Every key of a nested messages object, with its text: `max.string` → '…'. */
function flatten(messages: object, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') flat[`${prefix}${key}`] = value;
    else Object.assign(flat, flatten(value as object, `${prefix}${key}.`));
  }
  return flat;
}

const catalog = new Catalog({ fallback: 'en' }).add('en', 'marmeon', frameworkEn, 'en').add('de', 'marmeon', frameworkDe, 'de');

describe('the texts of @marmeon/validation (E197): English and German for every rule', () => {
  const rules = flatten(VALIDATION_TEXTS);
  const en = flatten(frameworkEn.validation);
  const de = flatten(frameworkDe.validation);

  it('English here is the English the package keeps inline (what an app without @marmeon/i18n reads)', () => {
    for (const [key, text] of Object.entries(rules)) expect(en[key], `marmeon.validation.${key}`).toBe(text);
  });

  it('German for every rule — in its own words, with the same placeholders', () => {
    for (const [key, text] of Object.entries(rules)) {
      const german = de[key];
      expect(german, `marmeon.validation.${key} has no German text`).toBeTypeOf('string');
      expect(german, `marmeon.validation.${key} is still English`).not.toBe(text);
      const placeholders = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(german!), `marmeon.validation.${key}`).toEqual(placeholders(text));
    }
  });

  it('a German request reads the rules in German — with the field\'s name', async () => {
    const schema = r.object({ email: r.string().trim().email().max(10), name: r.string().required(), terms: r.accepted() });
    const result = await schema['~standard'].validate({ email: 'ada@example.com', name: '' });
    const error = ValidationError.fromIssues(result.issues!, {}, { attributes: { email: 'E-Mail' } });
    expect(error.errors).toEqual({
      email: ['The E-Mail field must not be longer than 10 characters.'],
      name: ['The name field is required.'],
      terms: ['The terms field must be accepted.'],
    });
    const german = error.translate(createTranslator(catalog, () => 'de', { locales: () => ['en', 'de'] }));
    expect(german.errors.email?.[0], 'German max.string').toBe('Das Feld E-Mail darf höchstens 10 Zeichen haben.');
    expect(german.errors).toEqual({
      email: ['Das Feld E-Mail darf höchstens 10 Zeichen haben.'],
      name: ['Das Feld name ist erforderlich.'],
      terms: ['Das Feld terms muss akzeptiert werden.'],
    });
    expect(german.message).toBe('Das Feld E-Mail darf höchstens 10 Zeichen haben. (und 2 weitere Fehler)');
  });
});
