import type { Upload } from '@marmeon/http/page';
import { translatable, type JoinNames } from '@marmeon/router';
import { metaOf, rules as r, type Rule } from '@marmeon/validation';
import { isActiveType, UPLOAD_TYPES, type UploadMime } from './sniff.ts';
import { RejectedUpload, TemporaryUpload, type UploadProblem } from './temporary-upload.ts';

/** Where a schema carries its upload rule — found by the upload target and the validation hook. */
export const UPLOAD_RULE = Symbol.for('marmeon.upload-rule');

/** What an `upload()` rule allows. */
export interface UploadRule {
  /** The largest file in bytes — checked while the bytes arrive (the upload is cut off) and again on submit. */
  readonly maxBytes: number;
  /** The types accepted, by the file's bytes — undefined: any type but markup a browser would run (HTML, SVG, XML). */
  readonly mime: readonly UploadMime[] | undefined;
}

/** What a form holds in an upload field: the upload (sent as its token), or nothing yet. (A test sends the token: `app.upload(…)`.) */
export type UploadInput = Upload | null;

/** What `upload()` is: a rule of @marmeon/validation — the form sends an upload's token, the controller gets the verified upload. */
export type UploadSchema = Rule<TemporaryUpload, UploadInput>;

type Near<M extends string> = M extends `${infer Group}/${string}` ? Extract<UploadMime, `${Group}/${string}`> : never;

/** `M` when an upload can be recognised as it; otherwise the message the compiler shows as the expected type. */
export type CheckUploadMime<M extends string> = M extends UploadMime
  ? M
  : M extends 'image/svg+xml' | 'text/html' | 'application/xml' | 'text/xml' | 'application/xhtml+xml'
    ? `'${M}' is never accepted — a browser runs script in it (upload a raster image or a PDF instead)`
    : [Near<M>] extends [never]
      ? `'${M}' is not a type an upload is recognised as by its bytes — leave out mime for any type, or name some of: ${JoinNames<UploadMime>}`
      : `'${M}' is not a type an upload is recognised as by its bytes — did you mean ${JoinNames<Near<M>>}?`;

/** Message keys of the rule (namespace `marmeon`), with the English text for apps without @marmeon/i18n. */
const MESSAGES: Record<UploadProblem | 'required' | 'max' | 'type', [key: string, fallback: string]> = {
  required: ['marmeon.validation.upload.required', 'Choose a file.'],
  invalid: ['marmeon.validation.upload.invalid', 'The file did not arrive — choose it again.'],
  expired: ['marmeon.validation.upload.expired', 'The upload expired — choose the file again.'],
  used: ['marmeon.validation.upload.used', 'This file was saved already — choose it again.'],
  max: ['marmeon.validation.upload.max', 'The file may be at most {max}.'],
  type: ['marmeon.validation.upload.type', 'This type of file is not accepted (allowed: {types}).'],
};

function message(kind: keyof typeof MESSAGES, params: Record<string, unknown> = {}): (issue: object) => string {
  const [key, fallback] = MESSAGES[kind];
  return translatable(key, params, fallback);
}

/** `2000000` → `2 MB`, `1536` → `1.5 KB` (decimal units, as files are sold). */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : Number(value.toFixed(1))} ${units[unit]}`;
}

/** `image/png` → `PNG`. */
const label = (mime: string) => UPLOAD_TYPES[mime as UploadMime]?.toUpperCase() ?? mime;

/**
 * A file uploaded ahead, as the rule of a form field: `upload({ maxBytes: 2_000_000, mime: ['image/png'] })`. The form sends
 * the upload's token; on submit the token and the file are checked (its size, and its type **by its bytes**, never the name
 * or the `Content-Type` the browser sent), and the controller gets a {@link TemporaryUpload}. HTML, SVG and XML are never
 * accepted, whatever `mime` says; `upload(…).nullable()` makes the file optional. See `docs/storage.md#uploads`.
 */
export function upload<const M extends string = UploadMime>(options: { readonly maxBytes: number; readonly mime?: readonly CheckUploadMime<M>[] }): UploadSchema {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new RangeError(`upload() needs maxBytes > 0, not ${String(options.maxBytes)}.`);
  const rule: UploadRule = { maxBytes: options.maxBytes, mime: options.mime as readonly UploadMime[] | undefined };
  for (const mime of rule.mime ?? []) {
    if (!(mime in UPLOAD_TYPES) || (mime as string) === 'application/octet-stream') throw new TypeError(`upload() cannot recognise "${mime}" by its bytes — see UPLOAD_TYPES.`);
  }
  const types = (rule.mime ?? []).map(label).join(', ');
  const tooLarge = message('max', { max: formatBytes(rule.maxBytes) });
  const wrongType = message('type', { types: types || 'any but HTML, SVG and XML' });
  return r.value<TemporaryUpload, UploadInput>(
    (value) => {
      if (value === null || value === undefined || value === '') return message('required');
      // Anything the validation hook did not verify — a token it never saw, a file sent as the body: refused.
      if (value instanceof RejectedUpload) return message(value.problem);
      if (!(value instanceof TemporaryUpload)) return message('invalid');
      if (value.size > rule.maxBytes) return tooLarge;
      if (isActiveType(value.mime) || (rule.mime !== undefined && !rule.mime.includes(value.mime as UploadMime))) return wrongType;
      return undefined;
    },
    { meta: { [UPLOAD_RULE]: rule } },
  );
}

/** The `upload()` rule of `schema`, when it is one — also through `.nullable()`, `.optional()`, `.custom()` (the rules made from it keep its mark). */
export function uploadRuleOf(schema: unknown): UploadRule | undefined {
  return metaOf(schema, UPLOAD_RULE) as UploadRule | undefined;
}

/**
 * The upload fields of a body schema — an object of rules (`r.object`) — by path (`avatar`, `profile.photo`): its fields, and
 * the fields of objects in it. Lists of files and optional objects of files are not supported yet.
 */
export function uploadFields(schema: unknown): Map<string, UploadRule> {
  const found = new Map<string, UploadRule>();
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 10) return;
    const rule = uploadRuleOf(node);
    if (rule) {
      if (path !== '') found.set(path, rule);
      return;
    }
    // An object rule's fields (`r.object()`'s `entries`).
    const entries = typeof node === 'object' && node !== null ? (node as { readonly entries?: unknown }).entries : undefined;
    if (typeof entries === 'object' && entries !== null) {
      for (const [key, entry] of Object.entries(entries)) walk(entry, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };
  walk(schema, '', 0);
  return found;
}
