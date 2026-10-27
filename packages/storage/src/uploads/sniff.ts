/**
 * What a file is, by its first bytes — never by the name the browser sent or the `Content-Type` it claimed: both are
 * the uploader's word. Only formats with a reliable signature are recognised; anything else is `application/octet-stream`.
 * Markup that a browser would render — HTML, SVG, XML — is recognised so it can be refused (it can carry script).
 */

/** @internal `UploadMime` names the types an upload rule accepts: those {@link sniff} recognises by their bytes. */
export const UPLOAD_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'application/octet-stream': 'bin',
} as const;

/** A type an upload rule can name in `mime` (`upload({ mime: ['image/png'] })`). */
export type UploadMime = Exclude<keyof typeof UPLOAD_TYPES, 'application/octet-stream'>;

/** Types an upload never is, whatever a rule says: a browser runs their script (HTML, SVG, XML with XHTML in it). */
export const ACTIVE_TYPES = ['text/html', 'image/svg+xml', 'application/xml'] as const;
export type ActiveType = (typeof ACTIVE_TYPES)[number];

/** What {@link sniff} found: a type and the extension a stored file gets. */
export interface Sniffed {
  readonly mime: UploadMime | ActiveType | 'application/octet-stream';
  readonly extension: string;
}

/** How many bytes {@link sniff} looks at. */
export const SNIFF_BYTES = 1024;

const ascii = (bytes: Uint8Array, at: number, text: string) => {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) => signature.every((byte, i) => bytes[i] === byte);

/** ISO base media (`ftyp` box): the brands an MP4 or an AVIF names. */
function isoBrands(bytes: Uint8Array): string[] {
  if (!ascii(bytes, 4, 'ftyp') || bytes.length < 16) return [];
  const size = Math.min(bytes.length, ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0);
  const brands = [String.fromCharCode(...bytes.subarray(8, 12))];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
  return brands;
}

/**
 * Markup a browser would render, after a BOM and whitespace (the WHATWG MIME sniffing rules' "HTML", plus SVG and XML): a tag
 * like `<html`, `<script`, `<svg`, `<!DOCTYPE html`, `<?xml`, `<!--`.
 */
function markup(bytes: Uint8Array): ActiveType | undefined {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SNIFF_BYTES));
  text = text.replace(/^﻿/, '').replace(/^[\s\0]+/, '').toLowerCase();
  if (/^<svg[\s>/]/.test(text)) return 'image/svg+xml';
  if (text.startsWith('<?xml')) return /<svg[\s>/]/.test(text) ? 'image/svg+xml' : /<html[\s>/]|<script[\s>/]/.test(text) ? 'text/html' : 'application/xml';
  if (/^<(!doctype html|html|head|body|script|iframe|h1|div|font|table|a|style|title|b|br|p|img|object|embed|!--)[\s>/!]/.test(text)) {
    return /<svg[\s>/]/.test(text.slice(0, 200)) && !/<html[\s>/]/.test(text) ? 'image/svg+xml' : 'text/html';
  }
  return undefined;
}

/** The type of a file by its first bytes ({@link SNIFF_BYTES} are enough). */
export function sniff(bytes: Uint8Array): Sniffed {
  const found = (mime: UploadMime): Sniffed => ({ mime, extension: UPLOAD_TYPES[mime] });
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return found('image/png');
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return found('image/jpeg');
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return found('image/gif');
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return found('image/webp');
  if (ascii(bytes, 0, '%PDF-')) return found('application/pdf');
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return found('application/zip');
  if (ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) !== 0)) return found('audio/mpeg');
  const brands = isoBrands(bytes);
  if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return found('image/avif');
  if (brands.some((brand) => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand))) return found('video/mp4');
  const active = markup(bytes);
  if (active) return { mime: active, extension: active === 'text/html' ? 'html' : active === 'image/svg+xml' ? 'svg' : 'xml' };
  return { mime: 'application/octet-stream', extension: 'bin' };
}

/** Whether `mime` is a type a browser would run script in. */
export function isActiveType(mime: string): mime is ActiveType {
  return (ACTIVE_TYPES as readonly string[]).includes(mime);
}
