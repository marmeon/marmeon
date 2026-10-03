import type { Upload } from '@bespokecore/http/page';
import type { JoinNames } from '@bespokecore/router';
import * as v from 'valibot';
import { isActiveType, UPLOAD_TYPES, type UploadMime } from './sniff.ts';
import { RejectedUpload, TemporaryUpload, type UploadProblem } from './temporary-upload.ts';

/** Where a schema carries its upload rule — found by the upload target and the validation hook. */
export const UPLOAD_RULE = Symbol.for('bespokecore.upload-rule');

/** What an `upload()` rule allows. */
export interface UploadRule {
  /** The largest file in bytes — checked while the bytes arrive (the upload is cut off) and again on submit. */
  readonly maxBytes: number;
  /** The types accepted, by the file's bytes — undefined: any type but markup a browser would run (HTML, SVG, XML). */
  readonly mime: readonly UploadMime[] | undefined;
}

/** What a form holds in an upload field: the upload (sent as its token), or nothing yet. (A test sends the token: `app.upload(…)`.) */
export type UploadInput = Upload | null;

export interface UploadSchema extends v.BaseSchema<UploadInput, TemporaryUpload, v.BaseIssue<unknown>> {
  readonly type: 'upload';
  readonly [UPLOAD_RULE]: UploadRule;
}

type Near<M extends string> = M extends `${infer Group}/${string}` ? Extract<UploadMime, `${Group}/${string}`> : never;

/** `M` when an upload can be recognised as it; otherwise the message the compiler shows as the expected type. */
export type CheckUploadMime<M extends string> = M extends UploadMime
  ? M
  : M extends 'image/svg+xml' | 'text/html' | 'application/xml' | 'text/xml' | 'application/xhtml+xml'
    ? `'${M}' is never accepted — a browser runs script in it (upload a raster image or a PDF instead)`
    : [Near<M>] extends [never]
      ? `'${M}' is not a type an upload is recognised as by its bytes — leave out mime for any type, or name some of: ${JoinNames<UploadMime>}`
      : `'${M}' is not a type an upload is recognised as by its bytes — did you mean ${JoinNames<Near<M>>}?`;

/** Message keys of the rule (namespace `bespoke`), with the English text for apps without @bespokecore/i18n. */
const MESSAGES: Record<UploadProblem | 'required' | 'max' | 'type', [key: string, fallback: string]> = {
  required: ['bespoke.validation.upload.required', 'Choose a file.'],
  invalid: ['bespoke.validation.upload.invalid', 'The file did not arrive — choose it again.'],
  expired: ['bespoke.validation.upload.expired', 'The upload expired — choose the file again.'],
  used: ['bespoke.validation.upload.used', 'This file was saved already — choose it again.'],
  max: ['bespoke.validation.upload.max', 'The file may be at most {max}.'],
  type: ['bespoke.validation.upload.type', 'This type of file is not accepted (allowed: {types}).'],
};

/** Where `translatable()` of the router leaves a message's key on an issue — the request's translator reads it. */
const TRANSLATION = Symbol.for('bespokecore.translation');

function message(kind: keyof typeof MESSAGES, params: Record<string, unknown> = {}): (issue: object) => string {
  const [key, fallback] = MESSAGES[kind];
  return (issue) => {
    try {
      Object.defineProperty(issue, TRANSLATION, { value: { key, params }, configurable: true });
    } catch {
      // A frozen issue keeps the English text.
    }
    return fallback.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  };
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
 * A file uploaded ahead (W6.9, Livewire's model) — the rule of a form field:
 *
 * ```ts
 * export const UpdateAvatarRequest = defineRequest({
 *   schema: v.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
 * });
 * // ctx.body.avatar is a TemporaryUpload: await ctx.body.avatar.store(this.#storage.disk('public'), 'avatars')
 * ```
 *
 * The browser uploads the file first (`<FileInput>`: to a target the route hands out for this field) and the form sends
 * only its token. On submit the token is checked — its signature, the session it was made for, the route and field, its
 * expiry, that it was not used — and the file itself: its size, and its type **by its bytes** (`mime`; never the name or
 * the `Content-Type` the browser sent). HTML, SVG and XML are never accepted, whatever `mime` says. `null` (nothing chosen)
 * is "required" — `v.nullish(upload(…))` for an optional file.
 */
export function upload<const M extends string = UploadMime>(options: { readonly maxBytes: number; readonly mime?: readonly CheckUploadMime<M>[] }): UploadSchema {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new RangeError(`upload() needs maxBytes > 0, not ${String(options.maxBytes)}.`);
  const rule: UploadRule = { maxBytes: options.maxBytes, mime: options.mime as readonly UploadMime[] | undefined };
  for (const mime of rule.mime ?? []) {
    if (!(mime in UPLOAD_TYPES) || (mime as string) === 'application/octet-stream') throw new TypeError(`upload() cannot recognise "${mime}" by its bytes — see UPLOAD_TYPES.`);
  }
  const types = (rule.mime ?? []).map(label).join(', ');
  return v._standardSchema({
    kind: 'schema',
    type: 'upload',
    reference: upload,
    expects: 'upload',
    async: false,
    [UPLOAD_RULE]: rule,
    // Valibot's own shape of a schema run (its internal helpers, exported for schemas like this one).
    '~run'(this: Parameters<typeof v._addIssue>[0], dataset: { value: unknown; typed?: boolean }, config: v.Config<v.BaseIssue<unknown>>) {
      const value = dataset.value;
      const fail = (kind: keyof typeof MESSAGES, params?: Record<string, unknown>) => {
        v._addIssue(this, 'upload', dataset as v.UnknownDataset, config, { message: message(kind, params), received: kind === 'required' ? 'nothing' : 'an upload it refuses' });
        return dataset;
      };
      if (value === null || value === undefined || value === '') return fail('required');
      // Anything the validation hook did not verify — a token it never saw, a file sent as the body: refused.
      if (value instanceof RejectedUpload) return fail(value.problem);
      if (!(value instanceof TemporaryUpload)) return fail('invalid');
      if (value.size > rule.maxBytes) return fail('max', { max: formatBytes(rule.maxBytes) });
      if (isActiveType(value.mime) || (rule.mime !== undefined && !rule.mime.includes(value.mime as UploadMime))) {
        return fail('type', { types: types || 'any but HTML, SVG and XML' });
      }
      dataset.typed = true;
      return dataset;
    },
  } as unknown as Omit<UploadSchema, '~standard'>) as unknown as UploadSchema;
}

/** The `upload()` rule of `schema`, when it is one (also through `v.pipe(upload(…), …)`, whose schema carries it). */
export function uploadRuleOf(schema: unknown): UploadRule | undefined {
  return (schema as { [UPLOAD_RULE]?: UploadRule } | null | undefined)?.[UPLOAD_RULE];
}

/**
 * The upload fields of a body schema, by path (`avatar`, `profile.photo`): objects (also loose/strict, async), their entries,
 * and what `optional`/`nullable`/`nullish` and friends wrap. Lists of files are not supported yet.
 */
export function uploadFields(schema: unknown): Map<string, UploadRule> {
  const found = new Map<string, UploadRule>();
  const walk = (node: unknown, path: string, depth: number) => {
    if (typeof node !== 'object' || node === null || depth > 10) return;
    const rule = uploadRuleOf(node);
    if (rule) {
      if (path !== '') found.set(path, rule);
      return;
    }
    const { entries, wrapped } = node as { entries?: unknown; wrapped?: unknown };
    if (wrapped !== undefined) return walk(wrapped, path, depth + 1);
    if (typeof entries === 'object' && entries !== null) {
      for (const [key, entry] of Object.entries(entries)) walk(entry, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };
  walk(schema, '', 0);
  return found;
}
