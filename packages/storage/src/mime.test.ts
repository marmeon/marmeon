import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { contentDisposition } from './index.ts';
import { serveFile } from './serve.ts';
import { MemoryDisk } from './drivers/memory.ts';

const fallbackOf = (value: string) => /filename="([^"]*)"/.exec(value)![1]!;
const encodedOf = (value: string) => /filename\*=UTF-8''(.*)$/.exec(value)![1]!;

describe('contentDisposition()', () => {
  it('names a plain file with the same name in both parameters', () => {
    expect(contentDisposition('attachment', 'report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`);
  });

  it('says inline or attachment', () => {
    expect(contentDisposition('inline', 'a.png')).toMatch(/^inline; /);
    expect(contentDisposition('attachment', 'a.png')).toMatch(/^attachment; /);
  });

  it('cannot break the header: no CR or LF, no quote or backslash outside the escape', () => {
    const value = contentDisposition('attachment', 'a"b\\c\r\nSet-Cookie: x=1\u0000\u2028.txt');
    expect(['\r', '\n', '\u0000', '\u2028'].some((c) => value.includes(c))).toBe(false);
    expect(fallbackOf(value)).toBe('a_b_c__Set-Cookie: x=1__.txt');
    expect(encodedOf(value)).not.toMatch(/["\\\r\n ]/);
    expect(decodeURIComponent(encodedOf(value))).toBe('a"b\\c\r\nSet-Cookie: x=1\u0000\u2028.txt');
  });

  it('turns non-ASCII characters into _ in the fallback and percent-encodes them as UTF-8', () => {
    const value = contentDisposition('attachment', 'Müller.csv');
    expect(fallbackOf(value)).toBe('M_ller.csv');
    expect(encodedOf(value)).toBe('M%C3%BCller.csv');
    expect(encodedOf(contentDisposition('attachment', '日本.csv'))).toBe('%E6%97%A5%E6%9C%AC.csv');
  });

  it("percent-encodes ' ( ) * so that filename* stays a valid RFC 8187 value", () => {
    expect(encodedOf(contentDisposition('attachment', "a'b(c)d*e.txt"))).toBe('a%27b%28c%29d%2Ae.txt');
  });

  it('keeps a path out of the fallback and encodes it in filename*', () => {
    const value = contentDisposition('attachment', '../../etc/passwd');
    expect(fallbackOf(value)).toBe('.._.._etc_passwd');
    expect(encodedOf(value)).toBe('..%2F..%2Fetc%2Fpasswd');
    expect(fallbackOf(contentDisposition('attachment', 'C:\\temp\\x.txt'))).toBe('C:_temp_x.txt');
  });

  it('carries a very long name through whole, still on one line', () => {
    const value = contentDisposition('attachment', `${'ä'.repeat(500)}.csv`);
    expect(value).not.toMatch(/[\r\n]/);
    expect(fallbackOf(value)).toBe(`${'_'.repeat(500)}.csv`);
    expect(encodedOf(value)).toBe(`${'%C3%A4'.repeat(500)}.csv`);
  });

  it('replaces % in the fallback, which some clients percent-decode', () => {
    expect(fallbackOf(contentDisposition('attachment', '100%0d.csv'))).toBe('100_0d.csv');
    expect(encodedOf(contentDisposition('attachment', '100%.csv'))).toBe('100%25.csv');
  });

  it('does not throw on a lone surrogate: it becomes U+FFFD', () => {
    const value = contentDisposition('attachment', 'a\uD800.csv');
    expect(encodedOf(value)).toBe('a%EF%BF%BD.csv');
    expect(fallbackOf(value)).toBe('a_.csv');
    expect(() => contentDisposition('attachment', '😀'.repeat(600).slice(0, 1000))).not.toThrow();
  });

  it('is the encoder serveFile() uses: one implementation', async () => {
    const disk = new MemoryDisk({ name: 'files', visibility: 'private', temporaryUrls: { sign: () => '' }, clock: new TestClock() });
    const name = 'a"b\r\nü/x.csv';
    await disk.put('k.csv', 'x');
    const response = await serveFile(disk, 'k.csv', new Request('http://localhost/'), { cacheControl: 'no-store', filename: name });
    expect(response.headers.get('content-disposition')).toBe(contentDisposition('attachment', name));
  });
});
