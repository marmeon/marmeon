import { Catalog } from './catalog.ts';
import { baseLanguage, isLanguageTag } from './locale.ts';

/** Language files by path, loaded lazily — `virtual:bespoke/lang` of `@bespokecore/vite` (one chunk per file). */
export type LangFiles = Readonly<Record<string, () => Promise<unknown>>>;

/** The namespace of the app-wide `lang/` folder (`lang/en.ts`); a module's is its name. */
export const APP_NAMESPACE = 'app';

/**
 * Namespace and locale of a language file: `modules/auth/lang/de.ts` → `{ namespace: 'auth', locale: 'de' }`,
 * `lang/en.ts` → `{ namespace: 'app', locale: 'en' }`. Undefined for anything else.
 */
export function langFileOf(path: string): { namespace: string; locale: string } | undefined {
  const match = /(?:^|\/)(?:modules\/([\w-]+)\/)?lang\/([^/]+)\.[jt]s$/.exec(path.replaceAll('\\', '/'));
  if (!match || !isLanguageTag(match[2])) return undefined;
  return { namespace: match[1] ?? APP_NAMESPACE, locale: match[2] };
}

export interface MessageLoader {
  /** The locale used for namespaces that have no file in the requested one (the app's `APP_FALLBACK_LOCALE`). */
  readonly fallback: string;
  /**
   * The messages of `locale`: for every namespace its file in `locale`, else in the locale's language
   * (`de-AT` → `de`), else in the fallback locale — nothing else is loaded. Once per locale; later calls share it.
   */
  load(locale: string): Promise<Catalog>;
}

/**
 * Loads language files on demand — in the browser and in the SSR entry, where pages render from the same messages:
 *
 * ```ts
 * import lang from 'virtual:bespoke/lang';
 * export const messages = createMessageLoader(lang, { fallback: 'en' });
 * ```
 *
 * A locale is only ever a key into `files` (never part of a path), so a page's `locale` cannot load anything but
 * the app's own language files.
 */
export function createMessageLoader(files: LangFiles, { fallback = 'en' }: { fallback?: string } = {}): MessageLoader {
  const byNamespace = new Map<string, Map<string, () => Promise<unknown>>>(); // namespace → locale → load
  for (const [path, load] of Object.entries(files)) {
    const file = langFileOf(path);
    if (!file) continue;
    const locales = byNamespace.get(file.namespace) ?? new Map<string, () => Promise<unknown>>();
    locales.set(file.locale, load);
    byNamespace.set(file.namespace, locales);
  }

  const loaded = new Map<string, Promise<Catalog>>();
  const loadLocale = async (locale: string): Promise<Catalog> => {
    const catalog = new Catalog({ fallback });
    const wanted = [locale, baseLanguage(locale), fallback, baseLanguage(fallback)].filter((candidate) => candidate !== undefined);
    await Promise.all(
      [...byNamespace].map(async ([namespace, locales]) => {
        const chosen = wanted.find((candidate) => locales.has(candidate));
        if (chosen === undefined) return;
        const module = await locales.get(chosen)!();
        catalog.add(chosen, namespace, (module as { default?: unknown } | null)?.default, `${namespace}/lang/${chosen}`);
      }),
    );
    return catalog;
  };

  return {
    fallback,
    load(locale) {
      const key = isLanguageTag(locale) ? locale : fallback;
      let catalog = loaded.get(key);
      if (!catalog) {
        catalog = loadLocale(key);
        loaded.set(key, catalog);
        // A failed load (a chunk the network lost) may be tried again.
        catalog.catch(() => loaded.delete(key));
      }
      return catalog;
    },
  };
}
