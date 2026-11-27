import * as fetch from '@marmeon/fetch';
import { describe, expect, it } from 'vitest';
import { MailDeliveryError } from '../mailer.ts';
import { checkHeaders, formatAddress, importFetch, messageIdOf, postJson, retryAfterSeconds } from './api.ts';

describe('formatAddress', () => {
  it('quotes a display name, so that it cannot add a recipient to a comma-separated list', () => {
    expect(formatAddress({ address: 'ada@example.com', name: 'Evil, x@attacker.example' })).toBe('"Evil, x@attacker.example" <ada@example.com>');
    expect(formatAddress({ address: 'ada@example.com', name: 'Ada Lovelace' })).toBe('"Ada Lovelace" <ada@example.com>');
  });

  it('escapes a quote and a backslash in the name', () => {
    expect(formatAddress({ address: 'ada@example.com', name: 'A "B" \\ C' })).toBe('"A \\"B\\" \\\\ C" <ada@example.com>');
  });

  it('encodes a name that is not printable ASCII as RFC 2047 words, in pieces of at most 75 characters', () => {
    expect(formatAddress({ address: 'zoe@example.com', name: 'Zoë' })).toBe('=?UTF-8?B?Wm/Dqw==?= <zoe@example.com>');
    const long = formatAddress({ address: 'zoe@example.com', name: 'ë'.repeat(60) });
    const words = long.slice(0, long.lastIndexOf(' <')).split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    // a word never cuts a character in half
    expect(words.map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8')).join('')).toBe('ë'.repeat(60));
  });

  it('keeps a name with a line break out of the header text: it is encoded', () => {
    expect(formatAddress({ address: 'ada@example.com', name: 'A\r\nBcc: x@attacker.example' })).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ada@example\.com>$/);
  });

  it('gives the bare address without a name, and for an empty one', () => {
    expect(formatAddress({ address: 'ada@example.com' })).toBe('ada@example.com');
    expect(formatAddress({ address: 'ada@example.com', name: '' })).toBe('ada@example.com');
  });

  it('refuses an address that is not a plain local@host, without naming it', () => {
    for (const address of ['a@b.c, d@e.f', 'a b@c.d', 'x<y>@z.test', '"a"@b.c', 'no-at-sign']) {
      const error = (() => {
        try {
          return formatAddress({ address });
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, address).toBeInstanceOf(MailDeliveryError);
      expect((error as MailDeliveryError).reason).toBe('refused');
      expect(String(error)).not.toContain(address);
    }
  });
});

describe('checkHeaders', () => {
  const reason = (headers: Record<string, string>): unknown => {
    try {
      return checkHeaders(headers, 'postmark');
    } catch (error) {
      return error;
    }
  };

  it('refuses the headers that address the mail or shape it, in any case', () => {
    for (const name of ['bcc', 'BCC', 'Reply-To', 'To', 'cc', 'From', 'Sender', 'Subject', 'Date', 'Message-ID', 'Return-Path', 'MIME-Version', 'Content-Type', 'content-transfer-encoding']) {
      const error = reason({ [name]: 'x@attacker.example' });
      expect(error, name).toBeInstanceOf(MailDeliveryError);
      expect((error as MailDeliveryError).reason, name).toBe('refused');
      expect((error as MailDeliveryError).permanent, name).toBe(true);
    }
  });

  it('lets a header that adds no recipient through, as name and value', () => {
    expect(checkHeaders({ 'List-Unsubscribe': '<https://app.test/u/1>', 'X-Entity': 'a' }, 'postmark')).toEqual([
      { name: 'List-Unsubscribe', value: '<https://app.test/u/1>' },
      { name: 'X-Entity', value: 'a' },
    ]);
  });

  it('refuses a header name that is no token and a value with a line break', () => {
    expect(reason({ 'X Bad': 'a' })).toBeInstanceOf(MailDeliveryError);
    expect(reason({ 'X-Ok': 'a\r\nBcc: x@attacker.example' })).toBeInstanceOf(MailDeliveryError);
  });

  it('refuses an empty name and a value that is no string', () => {
    expect(reason({ '': 'a' })).toBeInstanceOf(MailDeliveryError);
    expect(reason({ 'X-Count': 5 as unknown as string })).toBeInstanceOf(MailDeliveryError);
    expect(reason({ 'X-Missing': undefined as unknown as string })).toBeInstanceOf(MailDeliveryError);
  });
});

describe('retryAfterSeconds', () => {
  it('reads seconds and an HTTP date, clamped to 1 to 3600', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(retryAfterSeconds('12', now)).toBe(12);
    expect(retryAfterSeconds('1.2', now)).toBe(2);
    expect(retryAfterSeconds('0', now)).toBe(1);
    expect(retryAfterSeconds('999999', now)).toBe(3600);
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30);
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:00:00 GMT', now)).toBe(1);
    expect(retryAfterSeconds(null, now)).toBeUndefined();
    expect(retryAfterSeconds('soon', now)).toBeUndefined();
    expect(retryAfterSeconds('12 seconds', now)).toBeUndefined();
  });
});

describe('messageIdOf', () => {
  it('takes printable text up to 256 characters and nothing else', () => {
    expect(messageIdOf('0a129aa4-d3a8-4f39-b6c5-a7f0e3d3c3b2')).toBe('0a129aa4-d3a8-4f39-b6c5-a7f0e3d3c3b2');
    expect(messageIdOf('a'.repeat(256))).toBe('a'.repeat(256));
    for (const value of ['a'.repeat(257), '', 'has space', 'line\nbreak', 'é', 12, null, undefined, {}]) expect(messageIdOf(value), String(value)).toBeUndefined();
  });
});

describe('importFetch', () => {
  const error = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

  it('is undefined only when @marmeon/fetch itself is missing', async () => {
    expect(await importFetch(() => Promise.reject(error("Cannot find package '@marmeon/fetch' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
    expect(await importFetch(() => Promise.reject(error("Cannot find module '@marmeon/fetch' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
  });

  it('rethrows every other failure', async () => {
    await expect(importFetch(() => Promise.reject(error('boom while loading')))).rejects.toThrow('boom while loading');
    await expect(importFetch(() => Promise.reject(error("Cannot find package 'something-else' imported from x", 'ERR_MODULE_NOT_FOUND')))).rejects.toThrow('something-else');
    await expect(importFetch(() => Promise.reject(error('mentions @marmeon/fetch but has no code')))).rejects.toThrow('has no code');
    await expect(
      importFetch(() => Promise.reject(error("Cannot find package 'missing-dependency' imported from /app/node_modules/@marmeon/fetch/dist/index.js", 'ERR_MODULE_NOT_FOUND'))),
    ).rejects.toThrow('missing-dependency');
  });
});

describe('postJson reads an answer up to 64 KiB only', () => {
  /** An answer whose body never ends: 16 KiB a pull, counted, and a record of the cancel; no read-ahead, so a pull is a read. */
  const endless = (status: number) => {
    const seen = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.pulls++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        seen.cancelled = true;
      },
    }, { highWaterMark: 0 });
    const run = () =>
      postJson({
        http: () => ({ fetch: async () => new Response(body, { status }) }) as never,
        fetch,
        clock: { now: () => 0 },
        driver: 'test',
        credential: 'MAIL_TEST_KEY',
        url: 'https://api.test/mail',
        headers: {},
        json: {},
        codeOf: () => undefined,
      });
    return { seen, run };
  };

  it('resolves an accepted mail without reading on, and cancels the stream', async () => {
    const { seen, run } = endless(200);
    expect(await run()).toBeUndefined();
    expect(seen.pulls).toBeLessThanOrEqual(5);
    expect(seen.cancelled).toBe(true);
  });

  it('fails a 500 as unavailable without reading on, and cancels the stream', async () => {
    const { seen, run } = endless(500);
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).reason).toBe('unavailable');
    expect(seen.pulls).toBeLessThanOrEqual(5);
    expect(seen.cancelled).toBe(true);
  });
});
