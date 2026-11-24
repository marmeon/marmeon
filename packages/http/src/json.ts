import { ownResponse } from '@marmeon/router';
import { assertResultOptions, assertStatus, type ResultOptions } from './view.ts';
import { withFlashMethod, type FlashMethod } from './flash.ts';

const JSON_RESULT = Symbol.for('marmeon.json-result');

/**
 * What `this.json(data)` returns: data sent as JSON — typed, so the browser knows what it gets back. The answer of an
 * action (`useAction` of @marmeon/react): `result.data` is `Serialize<T>`, what JSON makes of it (a `Date` is its
 * string). Also an API's answer.
 */
export interface JsonResult<T = unknown> {
  readonly [JSON_RESULT]: true;
  /** The marker the action types read: this branch of a controller answers with data, not a page or a redirect. */
  readonly kind: 'json';
  readonly data: T;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A flash message delivered with the answer of an action: `this.json({ revoked: id }).flash('toast', { … })` — it
   * fires once, when `useAction` gets the answer. An API client (no action) never gets it: it waits for a page.
   */
  readonly flash: FlashMethod<JsonResult<T>>;
}

/**
 * `data` as JSON, with the `status` (default 200) and `headers` of the options. Throws a `TypeError` for a status that is not
 * a whole number from 200 to 599, and for 204, 205 and 304 with data. See docs/responses.md#json.
 */
export function json<T>(data: T, options: ResultOptions = {}): JsonResult<T> {
  const { status, headers } = assertResultOptions('json', options, data !== undefined);
  return withFlashMethod({ [JSON_RESULT]: true, kind: 'json', data, status, ...(headers ? { headers } : {}) } as JsonResult<T>);
}

export function isJsonResult(value: unknown): value is JsonResult {
  return typeof value === 'object' && value !== null && JSON_RESULT in value;
}

/** The response of a {@link JsonResult}. */
export function jsonResponse(result: JsonResult): Response {
  // A result is data: its status may have changed since json() checked it.
  assertStatus('json', result.status, result.data !== undefined);
  // `undefined` is no JSON (Response.json would throw): an answer without data.
  if (result.data === undefined) return ownResponse(new Response(null, { status: result.status === 200 ? 204 : result.status, headers: result.headers }));
  return ownResponse(Response.json(result.data, { status: result.status, headers: result.headers }));
}
