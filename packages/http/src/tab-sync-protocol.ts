/**
 * The tab-sync protocol the `tabSync` feature's chunk and the server share — a module of its own, so the core's first download
 * carries none of it. The epoch (`PageObject.epoch`, an HMAC keyed from `APP_KEY`) changes on a sign-in or sign-out, a
 * regenerated session or a language change; the tabs post only `{ v: 1, epoch }`, and the read-only `GET /_marmeon/session` has
 * the last word. See docs/client-features.md#what-it-does.
 */

/** Where the server says the current epoch. */
export const SESSION_PATH = '/_marmeon/session';

/** The header naming a tab's document on each of its requests — `x-marmeon-document: <id>` (random per document). */
export const DOCUMENT_HEADER = 'x-marmeon-document';

/** The channel the tabs of one browser share. */
export const TAB_SYNC_CHANNEL = 'marmeon';

/** What a tab posts on the channel — nothing else, ever. */
export interface TabSyncMessage {
  readonly v: 1;
  readonly epoch: string;
}

/** The answer of {@link SESSION_PATH}. */
export interface SessionEpochAnswer {
  readonly epoch: string;
}
