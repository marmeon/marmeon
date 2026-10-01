/**
 * The browser-safe core of `@bespokecore/i18n` — messages, the ICU subset, formatting, locale negotiation and the
 * loader of language files. No server code: UI adapters (`useTranslation` in @bespokecore/react) build on this.
 */
import { Catalog, type Formatter } from './catalog.ts';
import type { CheckKey, KeyOf, MessageAt, MessageTree, Namespace, TranslateArgs, Translations } from './types.ts';

export { Catalog, MessageError } from './catalog.ts';
export type { Formatter } from './catalog.ts';
export { formatMessage, formatParts, LocaleFormats, MessageSyntaxError, parseMessage } from './format.ts';
export type { Part } from './format.ts';
export { baseLanguage, isLanguageTag, LANGUAGE_TAG, negotiateLocale, supportedLocale } from './locale.ts';
export { APP_NAMESPACE, createMessageLoader, langFileOf } from './loader.ts';
export type { LangFiles, MessageLoader } from './loader.ts';
export type {
  CheckKey,
  CheckTranslationKey,
  KeyOf,
  MessageAt,
  MessageOf,
  Messages,
  MessageTree,
  Namespace,
  ParamsOf,
  TranslateArgs,
  TranslationKey,
  Translations,
} from './types.ts';

/** The messages of namespace `N` — its source file's type, once declared in `Translations`. */
export type MessagesOf<N extends string> = N extends keyof Translations ? Translations[N] : MessageTree;

/**
 * Translates the keys of one namespace — `t('login.title')`, `t('attempts', { count: 3 })` — keys and placeholders
 * checked against the namespace's source file. The result is plain text: render it as text, never as HTML.
 */
export interface Translate<N extends string = Namespace> {
  <K extends KeyOf<MessagesOf<N>> | (string & {})>(key: CheckKey<K, MessagesOf<N>, N>, ...params: TranslateArgs<MessageAt<MessagesOf<N>, K>>): string;
  /** The locale of the messages (the page's). */
  readonly locale: string;
  readonly namespace: N;
  /** Numbers, dates and relative times in the locale. */
  readonly format: Formatter;
  /** Whether the namespace has `key` (in the locale or the fallback locale). */
  has(key: string): boolean;
}

/** A {@link Translate} for `namespace` in `locale` — what a UI adapter's hook returns. */
export function createTranslate<N extends string>(catalog: Catalog, locale: string, namespace: N): Translate<N> {
  const t = (key: string, params?: Readonly<Record<string, unknown>>) => catalog.text(locale, `${namespace}.${key}`, params);
  return Object.assign(t, {
    locale,
    namespace,
    format: catalog.formatter(locale),
    has: (key: string) => catalog.has(locale, `${namespace}.${key}`),
  }) as unknown as Translate<N>;
}
