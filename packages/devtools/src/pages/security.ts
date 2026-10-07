import { PAGE_CSP } from './assets.ts';

/** An HTML page of the devtools, with its CSP. */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } });
}

/** JSON of the API. */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
