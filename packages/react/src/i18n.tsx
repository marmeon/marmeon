// Types only: @marmeon/i18n is an optional peer — apps without translations do not install it (and `marmeon discover`
// does not find its provider, its middleware and the session it needs).
import type { Catalog, Formatter, Namespace, Translate } from '@marmeon/i18n/messages';
import { createContext, useContext, useMemo } from 'react';

/** What the app's messages give a component: the page's `locale` and its `catalog`. */
export interface I18nValue {
  /** The page's locale (`PageObject.locale`). */
  readonly locale: string;
  /** Its messages — loaded before the page rendered (on the server and in the browser alike: no hydration mismatch). */
  readonly catalog: Catalog;
}

/**
 * Where {@link I18nValue} comes from for `useTranslation()` and `useLocale()`; `<MarmeonApp>` provides it. See
 * docs/localization.md#in-the-browser.
 */
export const I18nContext = createContext<I18nValue | null>(null);

function useI18n(hook: string): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error(
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
        ? `[marmeon:R12] ${hook} needs the app's messages: createMarmeonApp({ messages }) and createSsrRenderer(resolve, { messages }) — ` +
            "with `messages = createMessageLoader(lang)` from '@marmeon/i18n/messages' and `lang` from 'virtual:marmeon/lang'."
        : `[marmeon:R12] ${hook}`,
    );
  }
  return value;
}

/**
 * The messages of a namespace (a module's name, `app` for `lang/`) in the page's locale: `t(key, params)`, checked against the
 * language file, with `t.format` for numbers, dates and relative times. The texts are plain strings — React renders them as
 * text, never as HTML. See docs/localization.md#in-the-browser.
 */
export function useTranslation<N extends Namespace>(namespace: N): Translate<N> {
  const { catalog, locale } = useI18n('useTranslation()');
  return useMemo(() => catalog.translate(locale, namespace), [catalog, locale, namespace]);
}

/** The page's locale and its formatters — `const { locale, format } = useLocale()`. */
export function useLocale(): { locale: string; format: Formatter } {
  const { catalog, locale } = useI18n('useLocale()');
  return useMemo(() => ({ locale, format: catalog.formatter(locale) }), [catalog, locale]);
}
