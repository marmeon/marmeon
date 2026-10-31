import { basename } from './keys.ts';

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

/**
 * The `Content-Disposition` value that names a download, safe for any filename: an ASCII fallback in which quotes, backslashes,
 * slashes, percent signs, control characters (CR and LF cannot break the header) and non-ASCII characters become `_`, plus the
 * real name as `filename*` (RFC 8187; a lone surrogate becomes U+FFFD). `serveFile()` uses the same encoder. See docs/responses.md#downloads.
 */
export function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  // encodeURIComponent throws on a lone surrogate (a slice() through an emoji).
  filename = filename.toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7e]|["\\/%]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
