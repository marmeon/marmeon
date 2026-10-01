/** Locale tags and their negotiation — browser-safe, no state. */

/** A BCP 47 language tag as we accept one: `de`, `de-AT`, `zh-Hant-TW` — letters, digits, hyphens, nothing else. */
export const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && LANGUAGE_TAG.test(value);
}

/** `de-AT` → `de`; `de` → undefined. */
export function baseLanguage(locale: string): string | undefined {
  const at = locale.indexOf('-');
  return at === -1 ? undefined : locale.slice(0, at);
}

/**
 * The supported locale `value` names, in the spelling of `supported` (`DE` → `de`) — or undefined. The only way a
 * value from outside (a session, a header, a form) becomes a locale: anything not in the list is no locale at all.
 */
export function supportedLocale(value: unknown, supported: readonly string[]): string | undefined {
  if (!isLanguageTag(value)) return undefined;
  const wanted = value.toLowerCase();
  return supported.find((locale) => locale.toLowerCase() === wanted);
}

/** At most this many languages of an `Accept-Language` header are considered (the header is the client's). */
const MAX_LANGUAGES = 32;

/**
 * The best of `supported` for an `Accept-Language` header (`de-AT,de;q=0.9,en;q=0.5`) — by quality, then order; a
 * regional tag falls back to its language (`de-AT` → `de`), a language matches its first supported region
 * (`de` → `de-DE`). Undefined when nothing matches. Malformed entries are skipped; the header never becomes a locale
 * itself.
 */
export function negotiateLocale(header: string | null | undefined, supported: readonly string[]): string | undefined {
  if (!header || supported.length === 0) return undefined;
  const wanted = header
    .slice(0, 1024)
    .split(',')
    .slice(0, MAX_LANGUAGES)
    .map((entry, index) => {
      const [tag = '', ...parameters] = entry.trim().split(';');
      const q = parameters.map((parameter) => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(parameter)?.[1]).find((value) => value !== undefined);
      return { tag: tag.trim(), quality: q === undefined ? 1 : Number(q), index };
    })
    .filter(({ tag, quality }) => quality > 0 && quality <= 1 && isLanguageTag(tag))
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const { tag } of wanted) {
    const exact = supportedLocale(tag, supported);
    if (exact) return exact;
    const base = baseLanguage(tag);
    const language = base ? supportedLocale(base, supported) : undefined;
    if (language) return language;
    const region = supported.find((locale) => baseLanguage(locale)?.toLowerCase() === tag.toLowerCase());
    if (region) return region;
  }
  return undefined;
}
