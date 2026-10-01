import type { PageObject } from '../page.ts';

/**
 * The app's language files as the client core sees them — `createMessageLoader(lang)` of `@bespokecore/i18n/messages`
 * is one. Kept structural, so this core knows no i18n package: `C` is whatever the loader loads (a `Catalog`).
 */
export interface PageMessages<C = unknown> {
  /** The locale of pages that name none. */
  readonly fallback: string;
  /** The messages of `locale` — loaded once per locale. */
  load(locale: string): Promise<C>;
}

/** The locale a page renders in: its own (`PageObject.locale`), else the fallback locale of the language files. */
export function pageLocale(page: PageObject, messages: PageMessages): string {
  return page.locale ?? messages.fallback;
}

/**
 * The messages a page renders with, in its locale — undefined without language files. Adapters load them before a
 * page renders, in the browser and in the SSR entry alike, so the markup hydrates.
 */
export function loadPageMessages<C>(page: PageObject, messages: PageMessages<C> | undefined): Promise<C | undefined> {
  return messages ? messages.load(pageLocale(page, messages)) : Promise.resolve(undefined);
}
