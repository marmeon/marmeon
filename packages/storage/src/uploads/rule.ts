import type { Upload } from '@marmeon/http/page';
import { translatable, type JoinNames } from '@marmeon/router';
import { withCode } from '@marmeon/core/internal';
import { metaOf, rules as r, type Rule } from '@marmeon/validation';
import { contentsOf } from '@marmeon/validation/internal';
import { StorageSetupError } from '../errors.ts';
import type { ImageDimensions } from './dimensions.ts';
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
  /** Set: a text file of any format (a CSV), by its first bytes — no known signature, no markup, no NUL. Then `mime` is undefined. */
  readonly text?: true;
  /** Set: the most pixels an image may state in its header, measured before anything decodes it. Then `mime` names image types only. */
  readonly dimensions?: UploadDimensions;
}

/**
 * The pixel limits of an `upload()` image, as the header states its size (as a browser shows it): `maxWidth`, `maxHeight` and `maxPixels`
 * (width times height), each a positive integer, at least one. Building the rule throws for none, for a value that is no positive
 * integer and for a key it does not know. See `docs/validation.md#uploads`.
 */
export type UploadDimensions = {
  /** The widest image in pixels. */
  readonly maxWidth?: number;
  /** The tallest image in pixels. */
  readonly maxHeight?: number;
  /** The most pixels in all: width times height. */
  readonly maxPixels?: number;
} & ({ readonly maxWidth: number } | { readonly maxHeight: number } | { readonly maxPixels: number });

/** The types whose header {@link TemporaryUpload.dimensions} reads — the ones `dimensions` accepts in `mime`. */
export type DimensionMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const DIMENSION_MIMES: readonly DimensionMime[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const UPLOAD_OPTIONS: readonly string[] = ['maxBytes', 'mime', 'text', 'dimensions'];
const DIMENSION_LIMITS = ['maxWidth', 'maxHeight', 'maxPixels'] as const;

/**
 * What the validation hook read of each upload's header: its size, or `null` when the header could not be read. The rule refuses
 * an upload the hook never measured — a `TemporaryUpload` built or kept elsewhere is not trusted to be small.
 */
export const MEASURED = new WeakMap<TemporaryUpload, ImageDimensions | null>();

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

/** `M` when an image's header gives its pixel size; otherwise the message the compiler shows as the expected type. */
export type CheckDimensionMime<M extends string> = M extends DimensionMime
  ? M
  : M extends 'image/avif'
    ? `'image/avif' is not measured — its header holds the container's size, not the decoded image's (dimensions takes ${JoinNames<DimensionMime>})`
    : M extends UploadMime
    ? `'${M}' has no pixel size to check — dimensions takes ${JoinNames<DimensionMime>}`
    : CheckUploadMime<M>;

/** The `mime` an `upload()` takes: any recognisable type, or with `dimensions` image types only (a PDF has no pixel size). */
type MimeOption<M extends string, D> = [D] extends [undefined] ? { readonly mime?: readonly CheckUploadMime<M>[] } : { readonly mime: readonly CheckDimensionMime<M>[] };

/** Message keys of the rule (namespace `marmeon`), with the English text for apps without @marmeon/i18n. */
const MESSAGES: Record<UploadProblem | 'required' | 'max' | 'type' | 'text' | 'width' | 'height' | 'pixels' | 'unreadable', [key: string, fallback: string]> = {
  required: ['marmeon.validation.upload.required', 'Choose a file.'],
  invalid: ['marmeon.validation.upload.invalid', 'The file did not arrive — choose it again.'],
  expired: ['marmeon.validation.upload.expired', 'The upload expired — choose the file again.'],
  used: ['marmeon.validation.upload.used', 'This file was saved already — choose it again.'],
  max: ['marmeon.validation.upload.max', 'The file may be at most {max}.'],
  type: ['marmeon.validation.upload.type', 'This type of file is not accepted (allowed: {types}).'],
  text: ['marmeon.validation.upload.text', 'Only a text file is accepted, such as a CSV.'],
  width: ['marmeon.validation.upload.width', 'The image may be at most {max} pixels wide.'],
  height: ['marmeon.validation.upload.height', 'The image may be at most {max} pixels high.'],
  pixels: ['marmeon.validation.upload.pixels', 'The image may have at most {max} pixels.'],
  unreadable: ['marmeon.validation.upload.unreadable', 'The size of this image cannot be read — save it again as {types}.'],
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
 * accepted, whatever `mime` says; `text: true` instead of `mime` takes a text file of any format, a CSV for one: one with no
 * known signature, no markup at its start and no NUL (a script is text too, so the content is data to parse, never to run); `upload(…).nullable()` makes the file optional.
 * `dimensions: { maxPixels: 40_000_000 }` (with an image `mime`) refuses an image whose header states more, before any code decodes it;
 * a header that cannot be read is refused too (`docs/validation.md#uploads`). See `docs/storage.md#uploads`.
 */
export function upload<const M extends string = UploadMime, const D extends UploadDimensions | undefined = undefined>(
  options:
    | ({ readonly maxBytes: number; readonly text?: never; readonly dimensions?: D } & MimeOption<M, D>)
    | { readonly maxBytes: number; readonly text: true; readonly mime?: never; readonly dimensions?: never },
): UploadSchema {
  for (const key of Object.keys(options)) {
    if (!UPLOAD_OPTIONS.includes(key)) throw new TypeError(`upload() does not know the option "${key}" — it takes ${UPLOAD_OPTIONS.join(', ')}.`);
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new RangeError(`upload() needs maxBytes > 0, not ${String(options.maxBytes)}.`);
  if (options.text !== undefined && options.text !== true) throw new TypeError('upload() takes text: true or no text at all.');
  if (options.text && options.mime !== undefined) throw new TypeError('upload() takes text or mime, not both: text accepts any text file, mime names the types of files recognised by their bytes.');
  const dimensions = checkedDimensions(options);
  const rule: UploadRule = { maxBytes: options.maxBytes, mime: options.mime as readonly UploadMime[] | undefined, ...(options.text ? { text: true } : {}), ...(dimensions ? { dimensions } : {}) };
  for (const mime of rule.mime ?? []) {
    if (!(mime in UPLOAD_TYPES) || (mime as string) === 'application/octet-stream') throw new TypeError(`upload() cannot recognise "${mime}" by its bytes — see docs/storage.md#uploads for the types it can.`);
    if (dimensions && !(DIMENSION_MIMES as readonly string[]).includes(mime)) throw new TypeError(`upload() cannot check the pixel size of "${mime}" — dimensions takes ${DIMENSION_MIMES.join(', ')}.`);
  }
  const types = (rule.mime ?? []).map(label).join(', ');
  const tooLarge = message('max', { max: formatBytes(rule.maxBytes) });
  const wrongType = rule.text ? message('text') : message('type', { types: types || 'any but HTML, SVG and XML' });
  const unreadable = message('unreadable', { types });
  return r.value<TemporaryUpload, UploadInput>(
    (value) => {
      if (value === null || value === undefined || value === '') return message('required');
      // Anything the validation hook did not verify — a token it never saw, a file sent as the body: refused.
      if (value instanceof RejectedUpload) return message(value.problem);
      if (!(value instanceof TemporaryUpload)) return message('invalid');
      if (value.size > rule.maxBytes) return tooLarge;
      if (rule.text && !(value.mime === 'application/octet-stream' && value.plainText)) return wrongType;
      if (isActiveType(value.mime) || (rule.mime !== undefined && !rule.mime.includes(value.mime as UploadMime))) return wrongType;
      if (dimensions) {
        // Fail closed: a file the hook never measured (a direct validate()) or whose header says nothing is not known to be small.
        const size = MEASURED.get(value);
        if (!size) return unreadable;
        if (dimensions.maxWidth !== undefined && size.width > dimensions.maxWidth) return message('width', { max: String(dimensions.maxWidth) });
        if (dimensions.maxHeight !== undefined && size.height > dimensions.maxHeight) return message('height', { max: String(dimensions.maxHeight) });
        // Above 2^53 the product loses precision, far above any safe-integer limit, so the comparison stays right.
        if (dimensions.maxPixels !== undefined && size.width * size.height > dimensions.maxPixels) return message('pixels', { max: String(dimensions.maxPixels) });
      }
      return undefined;
    },
    { meta: { [UPLOAD_RULE]: rule } },
  );
}

/** The `dimensions` option as given, once it is known to be usable; undefined when there is none. */
function checkedDimensions(options: { readonly dimensions?: UploadDimensions | undefined; readonly mime?: readonly string[] | undefined; readonly text?: unknown }): UploadDimensions | undefined {
  const { dimensions } = options;
  if (dimensions === undefined) return undefined;
  if (options.text) throw new TypeError('upload() takes text or dimensions, not both: a text file has no pixel size.');
  if (options.mime === undefined) throw new TypeError(`upload() with dimensions needs mime: the image types to measure (${DIMENSION_MIMES.join(', ')}) — any type could let a file through unmeasured.`);
  if (typeof dimensions !== 'object' || dimensions === null) throw new TypeError('upload() takes dimensions as { maxWidth, maxHeight, maxPixels }.');
  for (const key of Object.keys(dimensions)) {
    if (!(DIMENSION_LIMITS as readonly string[]).includes(key)) throw new TypeError(`upload() does not know the dimensions limit "${key}" — it takes ${DIMENSION_LIMITS.join(', ')}.`);
  }
  const given = DIMENSION_LIMITS.filter((key) => dimensions[key] !== undefined);
  if (given.length === 0) throw new RangeError(`upload() needs at least one of ${DIMENSION_LIMITS.join(', ')} in dimensions.`);
  for (const key of given) {
    const value = dimensions[key];
    if (!Number.isSafeInteger(value) || value! <= 0) throw new RangeError(`upload() needs dimensions.${key} > 0, not ${String(value)}.`);
  }
  return { ...(dimensions.maxWidth !== undefined ? { maxWidth: dimensions.maxWidth } : {}), ...(dimensions.maxHeight !== undefined ? { maxHeight: dimensions.maxHeight } : {}), ...(dimensions.maxPixels !== undefined ? { maxPixels: dimensions.maxPixels } : {}) } as UploadDimensions;
}

/** The `upload()` rule of `schema`, when it is one — also through `.nullable()`, `.optional()`, `.custom()` (the rules made from it keep its mark). */
export function uploadRuleOf(schema: unknown): UploadRule | undefined {
  return metaOf(schema, UPLOAD_RULE) as UploadRule | undefined;
}

/** Whether an `upload()` is in `node` or below it — through the same cases as {@link contentsOf}; `seen` ends a loop in a shape an app changed. */
function holdsUpload(node: unknown, seen: WeakSet<object>): boolean {
  if (typeof node !== 'object' || node === null || seen.has(node)) return false;
  seen.add(node);
  if (uploadRuleOf(node)) return true;
  const contents = contentsOf(node);
  switch (contents?.kind) {
    case 'object':
      return [contents.fields, ...contents.conditional].some((shape) => Object.values(shape).some((entry) => holdsUpload(entry, seen)));
    case 'list':
      return holdsUpload(contents.item, seen);
    case 'union':
      return contents.options.some((option) => holdsUpload(option, seen));
    case 'modified':
      return holdsUpload(contents.rule, seen);
    default:
      return false;
  }
}

/**
 * The upload fields of a body schema — an object of rules (`r.object`) — by path (`avatar`, `profile.photo`): its fields, and
 * the fields of objects in it. An `upload()` anywhere else — in a list, in a union, in an optional or nullable object, in
 * fields that apply only under a condition — throws a {@link StorageSetupError}: the form could never send it.
 */
export function uploadFields(schema: unknown): Map<string, UploadRule> {
  const found = new Map<string, UploadRule>();
  const OPTIONAL = 'a file in an optional or nullable rule';
  // A list or a union says more than the optional rule around it.
  const reason = (outer: string | undefined, own: string) => (outer === undefined || outer === OPTIONAL ? own : outer);
  const walk = (node: unknown, path: string, depth: number, unsupported: string | undefined) => {
    // Depth counts the fields of objects; an upload found below the cap is refused, not skipped.
    if (depth > 10) {
      if (holdsUpload(node, new WeakSet())) throw new StorageSetupError(withCode('S2', `${path === '' ? 'The body' : `\`${path}\``} is nested deeper than 10 fields — flatten the body schema, the files in it cannot be found (docs/storage.md#uploads).`));
      return;
    }
    const rule = uploadRuleOf(node);
    if (rule) {
      if (unsupported !== undefined) {
        throw new StorageSetupError(
          withCode('S2', `${path === '' ? 'The body' : `\`${path}\``} holds ${unsupported}, which uploads do not support yet — give each file a field of its own in an object that is always there (docs/storage.md#uploads).`),
        );
      }
      if (path !== '') found.set(path, rule);
      return;
    }
    const contents = contentsOf(node);
    if (!contents) return;
    const field = (key: string) => (path === '' ? key : `${path}.${key}`);
    switch (contents.kind) {
      case 'object':
        for (const [key, entry] of Object.entries(contents.fields)) walk(entry, field(key), depth + 1, unsupported);
        for (const shape of contents.conditional) {
          for (const [key, entry] of Object.entries(shape)) walk(entry, field(key), depth + 1, reason(unsupported, 'a file in fields that apply only under a condition'));
        }
        break;
      case 'list':
        walk(contents.item, path, depth, reason(unsupported, 'a list of files'));
        break;
      case 'union':
        for (const option of contents.options) walk(option, path, depth, reason(unsupported, 'a file in a union'));
        break;
      case 'modified':
        walk(contents.rule, path, depth, unsupported ?? OPTIONAL);
        break;
    }
  };
  walk(schema, '', 0, undefined);
  return found;
}
