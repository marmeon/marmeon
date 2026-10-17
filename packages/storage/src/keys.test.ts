import { describe, expect, it } from 'vitest';
import { InvalidKeyError } from './errors.ts';
import { encodeKey, keyFromPath, normalizeDirectory, normalizeKey } from './keys.ts';
import { contentDisposition, isInlineType, mimeTypeOf } from './mime.ts';

describe('normalizeKey', () => {
  it('takes relative, /-separated keys as they are', () => {
    for (const key of ['a.txt', 'avatars/7.webp', 'a/b/c/d.json', 'über/ä ö.png', '.hidden', 'a..b', '...', 'name with spaces']) {
      expect(normalizeKey(key)).toBe(key);
    }
  });

  it.each([
    ['../../.env', '".." segment'],
    ['avatars/../secret.txt', '".." segment'],
    ['..', '".." segment'],
    ['./a', '"." segment'],
    ['a/./b', '"." segment'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/win.ini', 'drive letter'],
    ['a\\..\\b', 'backslash'],
    ['..\\x', 'backslash'],
    ['a\u0000.png', 'NUL'],
    ['a\nb', 'control character'],
    ['a//b', 'empty segment'],
    ['a/', 'empty segment'],
    ['', 'non-empty'],
  ])('refuses %j (%s)', (key, reason) => {
    expect(() => normalizeKey(key)).toThrow(InvalidKeyError);
    expect(() => normalizeKey(key)).toThrow('[marmeon:S3] Invalid storage key');
    expect(() => normalizeKey(key)).toThrow(reason);
  });

  it('refuses keys longer than 1024 bytes (counted in UTF-8)', () => {
    expect(normalizeKey('a'.repeat(1024))).toHaveLength(1024);
    expect(() => normalizeKey('ä'.repeat(513))).toThrow('longer than 1024 bytes');
  });

  it('directories: "" and "/" are the root, a trailing "/" is fine, the rest like keys', () => {
    expect(normalizeDirectory('')).toBe('');
    expect(normalizeDirectory('/')).toBe('');
    expect(normalizeDirectory('avatars/')).toBe('avatars');
    expect(() => normalizeDirectory('../x')).toThrow(InvalidKeyError);
  });
});

describe('keyFromPath', () => {
  it('decodes each segment, then checks the key — an encoded "/" or ".." is checked too', () => {
    expect(keyFromPath('/storage/avatars/7.webp', '/storage')).toBe('avatars/7.webp');
    expect(keyFromPath(`/storage/${encodeKey('über/ä ö.png')}`, '/storage')).toBe('über/ä ö.png');
    expect(keyFromPath('/storage/%2e%2e/%2e%2e/.env', '/storage')).toBeUndefined();
    expect(keyFromPath('/storage/..%2f..%2f.env', '/storage')).toBeUndefined();
    expect(keyFromPath('/storage/a%5c..%5c.env', '/storage')).toBeUndefined(); // backslash
    expect(keyFromPath('/storage/a%00.png', '/storage')).toBeUndefined(); // NUL
    expect(keyFromPath('/storage/%2fetc%2fpasswd', '/storage')).toBeUndefined(); // an absolute key
    expect(keyFromPath('/storage/%E0%A4%A', '/storage')).toBeUndefined(); // malformed escape
    expect(keyFromPath('/storagex/a.png', '/storage')).toBeUndefined();
    expect(keyFromPath('/storage/', '/storage')).toBeUndefined();
  });
});

describe('content types', () => {
  it('by extension; only raster images are inline', () => {
    expect(mimeTypeOf('a/b.PNG')).toBe('image/png');
    expect(mimeTypeOf('x.svg')).toBe('image/svg+xml');
    expect(mimeTypeOf('noext')).toBe('application/octet-stream');
    expect(mimeTypeOf('.png')).toBe('application/octet-stream'); // a dotfile, not an extension
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'IMAGE/PNG; x=y']) expect(isInlineType(type)).toBe(true);
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'application/octet-stream', 'text/xml']) {
      expect(isInlineType(type)).toBe(false);
    }
  });

  it('Content-Disposition: a quoted ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`);
    expect(contentDisposition('attachment', 'a"b\\c\r\nd.txt')).toBe(`attachment; filename="a_b_c__d.txt"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.txt`);
    expect(contentDisposition('inline', "Über (1)'.png")).toBe(`inline; filename="_ber (1)'.png"; filename*=UTF-8''%C3%9Cber%20%281%29%27.png`);
  });
});
