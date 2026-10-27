/**
 * The browser-safe core of `@marmeon/i18n` — the message catalog, translating one namespace and the loader of language
 * files. No server code: UI adapters (`useTranslation` in @marmeon/react) build on this.
 */
import type { Formatter } from './catalog.ts';
import type frameworkEn from './lang/texts.ts';
import type { CheckMessageKey, MessageKeyOf, MessageAt, MessageTree, Namespace, TranslateArgs, Translations } from './types.ts';

export { Catalog, MessageError } from './catalog.ts';
export type { Formatter } from './catalog.ts';
export { MessageSyntaxError } from './format.ts';
export { createMessageLoader } from './loader.ts';
export type { LangFiles, MessageLoader } from './loader.ts';
export type { CheckMessageKey, MessageAt, MessageKeyOf, MessageOverrides, MessageParamsOf, Messages, MessageTree, Namespace, TranslateArgs, Translations } from './types.ts';

/**
 * The framework's own texts (namespace `marmeon`) in English — what `lang/marmeon/<locale>.ts` of an app may reword
 * (`satisfies MessageOverrides<FrameworkTexts>`) or translate in full (`satisfies Messages<FrameworkTexts>`).
 * See `docs/localization.md#the-frameworks-texts`.
 */
export type FrameworkTexts = typeof frameworkEn;

/** The messages of namespace `N` — its source file's type, once declared in `Translations`. */
export type MessagesOf<N extends string> = N extends keyof Translations ? Translations[N] : MessageTree;

/**
 * Translates the keys of one namespace — `t('login.title')`, `t('attempts', { count: 3 })` — keys and placeholders
 * checked against the namespace's source file. The result is plain text: render it as text, never as HTML.
 */
export interface Translate<N extends string = Namespace> {
  <K extends MessageKeyOf<MessagesOf<N>> | (string & {})>(key: CheckMessageKey<K, MessagesOf<N>, N>, ...params: TranslateArgs<MessageAt<MessagesOf<N>, K>>): string;
  /** The locale of the messages (the page's). */
  readonly locale: string;
  readonly namespace: N;
  /** Numbers, dates and relative times in the locale. */
  readonly format: Formatter;
  /** Whether the namespace has `key` (in the locale or the fallback locale). */
  has(key: string): boolean;
}
