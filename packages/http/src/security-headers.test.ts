import type { HttpContext } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers.ts';

const ctxFor = (url: string) => ({ request: new Request(url) }) as unknown as HttpContext;
const run = (options: Parameters<typeof securityHeaders>[0], respond: () => Response, url = 'https://app.test/page') => {
  const Middleware = securityHeaders(options);
  return new Middleware().handle(ctxFor(url), async () => respond());
};

describe('securityHeaders()', () => {
  it('sends nosniff, a referrer policy and X-Frame-Options on every kind of answer — no HSTS by default', async () => {
    const answers = [
      () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } }),
      () => Response.json({ ok: true }),
      () => Response.redirect('https://app.test/elsewhere', 302), // immutable headers
      () => new Response('Not found', { status: 404 }),
    ];
    for (const answer of answers) {
      const response = await run(undefined, answer);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('strict-transport-security')).toBeNull();
    }
  });

  it('keeps the X-Frame-Options and Referrer-Policy of a route, but always sends nosniff', async () => {
    const response = await run(
      undefined,
      () => new Response('embed', { headers: { 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'other' } }),
    );
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('replaces a route\'s X-Frame-Options or Referrer-Policy that is not a valid value', async () => {
    for (const value of ['ALLOW-FROM https://evil.test', 'ALLOWALL', 'DENY, SAMEORIGIN', 'XDENY', '', '  ']) {
      const response = await run(undefined, () => new Response('x', { headers: { 'x-frame-options': value } }));
      expect(response.headers.get('x-frame-options'), JSON.stringify(value)).toBe('DENY');
    }
    const lower = await run(undefined, () => new Response('x', { headers: { 'x-frame-options': ' sameorigin ' } }));
    expect(lower.headers.get('x-frame-options')).toBe(' sameorigin '.trim());
    for (const value of ['unsafe-url, bogus', 'bogus', '']) {
      const response = await run(undefined, () => new Response('x', { headers: { 'referrer-policy': value } }));
      expect(response.headers.get('referrer-policy'), JSON.stringify(value)).toBe('strict-origin-when-cross-origin');
    }
    // Policy tokens are case-insensitive, so a route's `NO-REFERRER` is a valid value and stays as it is.
    const upper = await run(undefined, () => new Response('x', { headers: { 'referrer-policy': 'NO-REFERRER' } }));
    expect(upper.headers.get('referrer-policy')).toBe('NO-REFERRER');
    const fallback = await run(undefined, () => new Response('x', { headers: { 'referrer-policy': 'no-referrer, strict-origin' } }));
    expect(fallback.headers.get('referrer-policy')).toBe('no-referrer, strict-origin');
  });

  it('takes the frame and referrer options, or leaves a header out with false', async () => {
    const changed = await run({ frameOptions: 'SAMEORIGIN', referrerPolicy: 'same-origin' }, () => new Response('x'));
    expect(changed.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(changed.headers.get('referrer-policy')).toBe('same-origin');
    const off = await run({ frameOptions: false, referrerPolicy: false }, () => new Response('x'));
    expect(off.headers.get('x-frame-options')).toBeNull();
    expect(off.headers.get('referrer-policy')).toBeNull();
  });

  it('sends HSTS over HTTPS only, from the configuration', async () => {
    const options = { hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true } };
    const secure = await run(options, () => new Response('x'));
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains; preload');
    const plain = await run(options, () => new Response('x'), 'http://app.test/page');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const short = await run({ hsts: { maxAge: 600 } }, () => new Response('x'));
    expect(short.headers.get('strict-transport-security')).toBe('max-age=600');
  });

  it("overwrites a route's own Strict-Transport-Security — a route cannot weaken it", async () => {
    const response = await run({ hsts: { maxAge: 31_536_000 } }, () => new Response('x', { headers: { 'strict-transport-security': 'max-age=0' } }));
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('allows maxAge 0 to withdraw HSTS, but not together with preload', async () => {
    const response = await run({ hsts: { maxAge: 0 } }, () => new Response('x'));
    expect(response.headers.get('strict-transport-security')).toBe('max-age=0');
    expect(() => securityHeaders({ hsts: { maxAge: 0, includeSubDomains: true, preload: true } })).toThrow(TypeError);
  });

  it('refuses a maxAge that is not a whole number of seconds, and a preload the lists would not take', () => {
    for (const maxAge of [-1, 1.5, Number.NaN]) {
      expect(() => securityHeaders({ hsts: { maxAge } }), String(maxAge)).toThrow(TypeError);
    }
    expect(() => securityHeaders({ hsts: { maxAge: 31_536_000, preload: true } })).toThrow(TypeError);
    expect(() => securityHeaders({ hsts: { maxAge: 600, includeSubDomains: true, preload: true } })).toThrow(TypeError);
    expect(() => securityHeaders({ hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true } })).not.toThrow();
  });
});
