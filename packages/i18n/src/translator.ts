import { Translator as TranslatorContract, type Token } from '@marmeon/core';
import type { Catalog, Formatter } from './catalog.ts';
import { supportedLocale } from './locale.ts';
import type { CheckTranslationKey, MessageOf, TranslateArgs, TranslationKey } from './types.ts';

/**
 * Translates the app's messages in one locale — on the server the **request's** (scoped: two requests never share one):
 * `translator.get('auth.throttled', { seconds: 30 })`, keys (`namespace.path`) and placeholders checked. Outside a request it
 * speaks `APP_LOCALE`; `Translators.for(locale)` gives a translator for any locale anywhere. The same token as the
 * `Translator` contract of @marmeon/core. See `docs/localization.md#on-the-server`.
 */
export interface Translator extends TranslatorContract {
  /** `key`'s message with its placeholders filled; the key itself when no locale has it. */
  get<K extends TranslationKey | (string & {})>(key: CheckTranslationKey<K>, ...params: TranslateArgs<MessageOf<K>>): string;
  /** The supported locales, the default first. */
  readonly locales: readonly string[];
  /** Numbers, dates and relative times in this locale. */
  readonly format: Formatter;
  /**
   * A translator for `locale` — for whoever the text is for, not who asked: a mail to a user in the user's stored
   * locale. Not a supported locale (or none): this translator's locale.
   */
  forLocale(locale: string | null | undefined): Translator;
}
export const Translator = TranslatorContract as Token<Translator>;

/** The locale of the current request — set by `SetLocale`, and again by `RequestLocale.use()`, read by the request's {@link Translator}. Scoped. */
export class CurrentLocale {
  #locale: string;
  /** Whether the route is localized, so its URL names the locale — set by `SetLocale`. */
  localized = false;

  constructor(locale: string) {
    this.#locale = locale;
  }

  get value(): string {
    return this.#locale;
  }

  set(locale: string): void {
    this.#locale = locale;
  }
}

export interface TranslatorOptions {
  /** The supported locales (read when needed: they are complete once the app booted). */
  readonly locales: () => readonly string[];
}

/** A {@link Translator} over the catalog; `locale` is read on every call (the request's may be set after creation). */
export function createTranslator(catalog: Catalog, locale: () => string, { locales }: TranslatorOptions): Translator {
  // An object literal with its getters — one per request (the request's `Translator`): half the cost of an object
  // completed with `Object.defineProperties` afterwards.
  const translator = {
    get: (key: string, params?: Readonly<Record<string, unknown>>) => catalog.text(locale(), key, params),
    has: (key: string) => catalog.has(locale(), key),
    text: (key: string, params?: Readonly<Record<string, unknown>>, fallback?: string) => catalog.text(locale(), key, params, fallback),
    forLocale(wanted: string | null | undefined): Translator {
      const fixed = supportedLocale(wanted, locales()) ?? locale();
      return createTranslator(catalog, () => fixed, { locales });
    },
    get locale() {
      return locale();
    },
    fallbackLocale: catalog.fallback,
    get locales() {
      return locales();
    },
    get format() {
      return catalog.formatter(locale());
    },
  };
  return translator as unknown as Translator;
}
