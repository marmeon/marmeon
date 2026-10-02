const JSON_RESULT = Symbol.for('bespokecore.json-result');

/**
 * What `this.json(data)` returns: data sent as JSON — typed, so the browser knows what it gets back. The answer of an
 * action (`useAction` of @bespokecore/react, E59): `result.data` is `Serialize<T>`, what JSON makes of it (a `Date` is its
 * string). Also an API's answer.
 */
export interface JsonResult<T = unknown> {
  readonly [JSON_RESULT]: true;
  /** The marker the action types read: this branch of a controller answers with data, not a page or a redirect. */
  readonly kind: 'json';
  readonly data: T;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** `data` as JSON, with `status` (default 200). */
export function json<T>(data: T, status = 200, headers?: Readonly<Record<string, string>>): JsonResult<T> {
  return { [JSON_RESULT]: true, kind: 'json', data, status, ...(headers ? { headers } : {}) };
}

export function isJsonResult(value: unknown): value is JsonResult {
  return typeof value === 'object' && value !== null && JSON_RESULT in value;
}

/** The response of a {@link JsonResult}. */
export function jsonResponse(result: JsonResult): Response {
  // `undefined` is no JSON (Response.json would throw): an answer without data.
  if (result.data === undefined) return new Response(null, { status: result.status === 200 ? 204 : result.status, headers: result.headers });
  return Response.json(result.data, { status: result.status, headers: result.headers });
}
