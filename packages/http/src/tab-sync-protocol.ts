/**
 * The tab-sync protocol — what the `tabSync` feature's chunk and the server share. A module of its own
 * (like `live-protocol.ts`): the core's first download carries none of it.
 *
 * - Every page object carries the session's **epoch** (`PageObject.epoch`): an opaque value (an HMAC keyed from `APP_KEY`) over
 *   the session's generation, the signed-in user and the locale — it changes when someone signs in or out, the session is
 *   regenerated or the language changes, and stays the same otherwise (flash messages, other session writes).
 * - The tabs of one browser tell each other over a `BroadcastChannel` ({@link TAB_SYNC_CHANNEL}) — only `{ v: 1, epoch }`
 *   ({@link TabSyncMessage}), never props, ids or tokens. A message is a hint: a tab that sees another epoch asks the server.
 * - The server's word: `GET /_marmeon/session` ({@link SESSION_PATH}) → `{ "epoch": "…" }` — `no-store`, read-only (it starts,
 *   writes and extends no session). Asked when a tab becomes visible again, comes back from the back/forward cache, or hears
 *   another epoch.
 * - Every request of a tab names its document ({@link DOCUMENT_HEADER}): a flash message is bound to the document whose request
 *   flashed it — another tab's request never takes it.
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
