import type { PageObject } from '../protocol.ts';

/**
 * The app's language files as the client core sees them — `createMessageLoader(lang)` of `@marmeon/i18n/messages`
 * is one. Kept structural, so this core knows no i18n package: `C` is whatever the loader loads (a `Catalog`).
 */
export interface PageMessages<C = unknown> {
  /** The fallback locale of pages that name none (a server without i18n). */
  readonly fallback: string;
  /** The messages of `locale`, falling back to `fallback` — loaded once per pair. */
  load(locale: string, options?: { fallback?: string }): Promise<C>;
}

/** The locale a page renders in: its own (`PageObject.locale`), else the fallback locale. */
export function pageLocale(page: PageObject, messages: PageMessages): string {
  return page.locale ?? page.fallbackLocale ?? messages.fallback;
}

/**
 * The messages a page renders with, in its locale — falling back the way the server does (`fallbackLocale`, the
 * server's `APP_FALLBACK_LOCALE`: configured once). Undefined without language files. Adapters load them before a
 * page renders, in the browser and in the SSR entry alike, so the markup hydrates.
 */
export function loadPageMessages<C>(page: PageObject, messages: PageMessages<C> | undefined): Promise<C | undefined> {
  if (!messages) return Promise.resolve(undefined);
  const locale = pageLocale(page, messages);
  return page.fallbackLocale === undefined ? messages.load(locale) : messages.load(locale, { fallback: page.fallbackLocale });
}
