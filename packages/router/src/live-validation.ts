import type { StandardIssue } from './request-definition.ts';

/**
 * Live validation (E62, Laravel's Precognition): a request to the route a form submits to — same method, same URL, same
 * body — that names the fields to check: `x-marmeon-validate: name,email`. The route runs as far as its validation: its
 * middleware (CSRF, authentication, throttling), its bindings, `authorize`, the request schema — then it answers `204` (the
 * named fields are valid) or `422` with the errors of the named fields only. Its controller's `handle` never runs: nothing is
 * created, sent or changed (the kernel also makes the request read-only, like an island's).
 *
 * The browser's copy of these names is in `@marmeon/http/page` (which may not import the router).
 */
export const VALIDATE_HEADER = 'x-marmeon-validate';

/** On a live validation's `204` and `422`: the fields it checked — what tells the client the answer is the validation's. */
export const VALIDATED_HEADER = 'x-marmeon-validated';

/** How many fields one live validation may name (a form, not a data structure). */
const MAX_FIELDS = 64;

/** A field path: `email`, `address.city`, `links.0.url` — letters, digits, `_`, `-`, dots between. */
const FIELD = /^[\w-]{1,100}(?:\.[\w-]{1,100}){0,9}$/;

/**
 * The fields a live validation names (`x-marmeon-validate`), or undefined for any other request. Unusable names are left out
 * — a request with none left is still a live validation (the router refuses it: 400), never a submit.
 */
export function liveValidationFields(request: Request): readonly string[] | undefined {
  const header = request.headers.get(VALIDATE_HEADER);
  if (header === null) return undefined;
  const fields = header
    .split(',')
    .map((field) => field.trim())
    .filter((field) => FIELD.test(field));
  return [...new Set(fields)].slice(0, MAX_FIELDS);
}

/** Whether `request` is a live validation (E62) — its controller's `handle` never runs. */
export function isLiveValidation(request: Request): boolean {
  return request.headers.has(VALIDATE_HEADER);
}

/**
 * Whether `issue` is about one of `fields`: its path is a named field or lies under one (`address` covers `address.city`).
 * An issue without a path (a check over the whole body) belongs to no field — a live validation drops it.
 */
export function issueOfFields(issue: StandardIssue, fields: readonly string[]): boolean {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment));
  if (path.length === 0) return false;
  return fields.some((field) => {
    const named = field.split('.');
    return named.length <= path.length && named.every((segment, index) => path[index] === segment);
  });
}
