import { basename } from './keys.ts';

// The encoder lives in the router (the table package needs it too); this is the same function.
export { contentDisposition } from '@marmeon/router';

/** Content types by extension — what a disk reports and serves (the bytes are not inspected here; uploads check them). */
const TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/vnd.microsoft.icon',
  ics: 'text/calendar',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mjs: 'text/javascript',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  wasm: 'application/wasm',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xhtml: 'application/xhtml+xml',
  xml: 'application/xml',
  zip: 'application/zip',
};

/** The content type for a key by its extension; `application/octet-stream` when unknown. */
export function mimeTypeOf(key: string): string {
  const name = basename(key);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/**
 * The only types a browser is allowed to show inline when a disk serves them: raster images, which cannot run script.
 * Everything else — HTML, SVG (it can carry `<script>`), PDF, XML, text — goes out as a download
 * (`Content-Disposition: attachment`).
 */
export const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** Whether a content type may be shown inline (parameters like `; charset` ignored). */
export function isInlineType(contentType: string): boolean {
  return INLINE_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());
}
