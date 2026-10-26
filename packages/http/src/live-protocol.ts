/**
 * The live protocol — what the live feature's chunk and the server share. A module of its own (like
 * `upload-header.ts`): only an app whose pages declare `live` loads the code that uses it, so no first download carries it.
 *
 * - Every request of a tab that follows live hints names its document: {@link CONNECTION_HEADER} — the server leaves that
 *   connection out of the hints a request of it causes (the tab that added a link does not reload for it).
 * - The stream: `GET /_marmeon/live?v=1&connection=<id>&c=<token>.<channel>&c=…` ({@link LIVE_PATH}, {@link LIVE_VERSION}) — one per document for every
 *   channel its page, islands and layers declare (`PageObject.live`), Server-Sent Events: `hello` (`{ seq, missed? }`, the
 *   current sequence of each channel) when it opens, `refresh` (`{ channel, only, seq }` — a hint, never data) and `end` (the
 *   session ended: do not reconnect).
 */

/** The header naming a tab's document on each of its requests — `x-marmeon-connection: <id>`. */
export const CONNECTION_HEADER = 'x-marmeon-connection';

/** Where a document's live stream is. */
export const LIVE_PATH = '/_marmeon/live';

/**
 * The version of the live stream's query and frames, sent as `v` on every stream request. The server answers a request without
 * it, with another or with two with `204`: the browser stops its own reconnecting, the tab asks again every
 * `LIVE_RETRY_REFUSED` and gets the same cheap `204`, until its next visit meets the new build's asset-version `409` and reloads.
 */
export const LIVE_VERSION = '1';
