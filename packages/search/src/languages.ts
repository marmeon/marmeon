import { withCode } from '@marmeon/core/internal';
import { SearchSetupError } from './errors.ts';

/*
 * Which Postgres text search configuration reads the text of a locale. Internal: `defineSearch({ languages })` in `config.ts` is
 * the public side. SQLite and Meilisearch do not use it.
 */

/** The configuration of every locale nothing maps: it lowercases words and neither stems nor drops stop words. */
export const FALLBACK_CONFIGURATION = 'simple';

/** The name a text search configuration may have here: what `pg_ts_config` holds, without a schema and never quoted. */
const CONFIGURATION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The languages every supported Postgres reads with a Snowball stemmer and stop words of its own, by ISO 639-1 code. Every other
 * locale reads with {@link FALLBACK_CONFIGURATION}.
 */
export const BUILT_IN_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  da: 'danish',
  de: 'german',
  en: 'english',
  es: 'spanish',
  fi: 'finnish',
  fr: 'french',
  hu: 'hungarian',
  it: 'italian',
  nl: 'dutch',
  no: 'norwegian',
  nb: 'norwegian',
  nn: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sv: 'swedish',
  tr: 'turkish',
});

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/**
 * The language map of an app: the built-in languages with the app's own on top, keyed by canonical locale (`de-CH`). Refuses with
 * Q9 a map that is no plain object, a locale that is no language tag, two spellings of one locale, and a configuration name outside
 * `/^[a-z_][a-z0-9_]{0,62}$/`.
 */
export function languageMap(languages: Readonly<Record<string, string>> = {}): ReadonlyMap<string, string> {
  const prototype: unknown = typeof languages === 'object' && languages !== null ? Object.getPrototypeOf(languages) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(languages).length !== Object.keys(languages).length) {
    throw setup('defineSearch({ languages }) takes a plain object of locales and text search configurations, such as { "de-CH": "german" }.');
  }
  const map = new Map(Object.entries(BUILT_IN_LANGUAGES));
  const seen = new Set<string>();
  for (const [locale, configuration] of Object.entries(languages)) {
    let canonical: string | undefined;
    try {
      [canonical] = Intl.getCanonicalLocales(locale);
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined) throw setup(`defineSearch({ languages }) maps ${JSON.stringify(locale)}, which is not a language tag such as "de" or "de-CH".`);
    if (seen.has(canonical)) throw setup(`defineSearch({ languages }) maps the locale ${canonical} twice; keep one spelling.`);
    seen.add(canonical);
    if (typeof configuration !== 'string' || !CONFIGURATION_NAME.test(configuration)) {
      throw setup(
        `defineSearch({ languages }) maps ${canonical} to ${JSON.stringify(configuration)}, which is not the name of a text search configuration: ` +
          'lowercase letters, digits and underscores, starting with a letter or an underscore, at most 63 characters, without a schema.',
      );
    }
    map.set(canonical, configuration);
  }
  return map;
}

/**
 * The configuration of a canonical locale: the one mapped to the locale itself, else the one mapped to its language subtag (`de`
 * for `de-CH`), else {@link FALLBACK_CONFIGURATION}. A document without a locale reads with the fallback too.
 */
export function configFor(locale: string | null, map: ReadonlyMap<string, string> = languageMap()): string {
  if (locale === null) return FALLBACK_CONFIGURATION;
  return map.get(locale) ?? map.get(locale.split('-')[0]!.toLowerCase()) ?? FALLBACK_CONFIGURATION;
}

/** Every configuration a map can give, the fallback included, each once and sorted. */
export function configurations(map: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set([...map.values(), FALLBACK_CONFIGURATION])].sort();
}
