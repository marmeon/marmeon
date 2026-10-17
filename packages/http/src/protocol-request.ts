/**
 * What a server checks of a request before it routes it: whether it speaks the page protocol, and in which version. A module
 * of its own — the browser's core sends the header, it never needs this list.
 */
import { CONNECTION_HEADER } from './live-protocol.ts';
import {
  ACTION_HEADER,
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PROTOCOL_VERSION,
  REGION_HEADER,
  speaksProtocol,
  VALIDATE_HEADER,
  VERSION_HEADER,
} from './protocol.ts';
import { DOCUMENT_HEADER } from './tab-sync-protocol.ts';
import { UPLOAD_HEADER } from './upload-header.ts';

/**
 * The versions of the page protocol a server accepts. Always includes `PROTOCOL_VERSION`.
 * @internal
 */
export const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set([PROTOCOL_VERSION]);

/**
 * The headers only the client of the page protocol sends. A request with any of them is a protocol request, and the server
 * checks its `x-marmeon` — an action or a validation of an old tab names no version at all.
 * @internal
 */
export const PROTOCOL_REQUEST_HEADERS: readonly string[] = [
  PAGE_HEADER,
  ACTION_HEADER,
  VALIDATE_HEADER,
  REGION_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  UPLOAD_HEADER,
  DOCUMENT_HEADER,
  CONNECTION_HEADER,
  VERSION_HEADER,
];

/**
 * Whether `request` comes from the client of the page protocol — it carries any of {@link PROTOCOL_REQUEST_HEADERS}.
 * @internal
 */
export function isProtocolRequest(request: Request): boolean {
  return PROTOCOL_REQUEST_HEADERS.some((name) => request.headers.has(name));
}

/**
 * Whether the request is a page visit: it speaks the protocol and is neither an action, a live validation nor an upload —
 * those carry the version too, but are answered with data, never with a page object or an error page.
 * @internal
 */
export function isVisit(headers: Headers): boolean {
  return speaksProtocol(headers) && !answersWithData(headers);
}

/**
 * Whether the request is an action, a live validation or an upload — by the headers being there, whatever their value (an old
 * tab does not send the current one). Their URL is no page to load.
 * @internal
 */
export function answersWithData(headers: Headers): boolean {
  return headers.has(ACTION_HEADER) || headers.has(VALIDATE_HEADER) || headers.has(UPLOAD_HEADER);
}
