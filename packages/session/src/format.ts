import type { SessionPayload } from './store.ts';

/** The key that marks a stored session payload with the format it was written in. */
export const FORMAT_KEY = '_v';

/** The format this release writes. */
export const SESSION_FORMAT = 1;

/**
 * The formats this release reads, each with the function that turns a payload of it into the current shape. Registering a
 * reader is how a later release keeps reading the format before it.
 * @internal
 */
export const SESSION_READERS = new Map<number, (data: SessionPayload) => SessionPayload>([[SESSION_FORMAT, (data) => data]]);

/**
 * What a stored payload is to this release:
 * - `ok` — a format it reads; `data` is the payload without its mark;
 * - `foreign` — a newer format than any it reads: another, newer process may be running and wrote it — to be left exactly as it is;
 * - `dropped` — no mark or one that means nothing (a session of an older release, a broken record): never interpreted, the
 *   request starts a new session.
 */
export type OpenedPayload = { readonly kind: 'ok'; readonly data: SessionPayload } | { readonly kind: 'foreign' } | { readonly kind: 'dropped' };

const DROPPED: OpenedPayload = { kind: 'dropped' };
const FOREIGN: OpenedPayload = { kind: 'foreign' };

/** Reads a session's JSON by its mark. Never guesses: an unmarked or malformed payload is dropped, a newer one foreign. */
export function openPayload(json: string): OpenedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return DROPPED;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DROPPED;
  const { [FORMAT_KEY]: version, ...data } = parsed as SessionPayload;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return DROPPED;
  const reader = SESSION_READERS.get(version);
  if (reader) return { kind: 'ok', data: reader(data) };
  return version > Math.max(...SESSION_READERS.keys()) ? FOREIGN : DROPPED;
}

/** The JSON a store keeps for `data`: marked with the current format (the mark always wins over a key of that name). */
export function sealPayload(data: SessionPayload): string {
  return JSON.stringify({ ...data, [FORMAT_KEY]: SESSION_FORMAT });
}

/** The empty payload as a new session loads it — what `save()` measures a conflict against. */
export const EMPTY_PAYLOAD = sealPayload({});
