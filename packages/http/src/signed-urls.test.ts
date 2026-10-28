import { createHmac } from 'node:crypto';
import { createApplication, defineModule } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionConfig, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, Router } from '@marmeon/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpServiceProvider } from './provider.ts';
import { signed, UrlSigner, ValidateSignature, withoutCsrfSignature } from './signed-urls.ts';

const routes = defineRoutes((Route) => {
  Route.middleware(signed()).get('/email/verify/:id/:hash', (ctx) => ({ id: ctx.params.id })).name('verify');
  Route.middleware(signed()).get('/unsubscribe/:id', (ctx) => ({ id: ctx.params.id })).name('unsubscribe');
});

const router = new Router().load(routes);
const keyOf = (key: string) => Buffer.from(key.slice('base64:'.length), 'base64');
const clock = new TestClock();
const signer = (key: string, previous: string[] = []) =>
  new UrlSigner(router, { key: keyOf(key), previousKeys: previous.map(keyOf) } as unknown as EncryptionConfig, clock);
const KEY = generateKey();

afterEach(() => vi.useRealTimers());

describe('UrlSigner', () => {
  it('begins the message for a route name that is not defined with H4', () => {
    expect(() => signer(KEY).signedRoute('nope', {}, { expiresIn: 60 })).toThrow('[marmeon:H4] Route [nope] is not defined.');
  });

  it('signs path and query; extra parameters go into the query; absolute with a base', () => {
    const url = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc', ref: 'mail' }, { expiresIn: 60 });
    expect(url).toMatch(/^\/email\/verify\/7\/abc\?ref=mail&expires=\d+&signature=[0-9a-f]{64}$/);
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    const absolute = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 60, base: 'https://app.example' });
    expect(absolute).toMatch(/^https:\/\/app\.example\/email\/verify\/7\/abc\?expires=\d+&signature=/);
    expect(signer(KEY).hasValidSignature(absolute)).toBe(true);
  });

  it('a changed parameter, a changed expiry, a signature from another route — all invalid', () => {
    const url = new URL(signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: { minutes: 60 } }), 'http://x');
    const tampered = (change: (url: URL) => void) => {
      const copy = new URL(url);
      change(copy);
      return signer(KEY).hasValidSignature(copy);
    };
    expect(tampered(() => {})).toBe(true);
    expect(tampered((u) => (u.pathname = '/email/verify/8/abc'))).toBe(false); // another user's id
    expect(tampered((u) => u.searchParams.set('expires', String(Number(u.searchParams.get('expires')) + 86_400)))).toBe(false);
    expect(tampered((u) => u.searchParams.delete('expires'))).toBe(false); // "never expires"
    expect(tampered((u) => u.searchParams.append('extra', '1'))).toBe(false);
    expect(tampered((u) => u.searchParams.delete('signature'))).toBe(false);
    expect(tampered((u) => u.searchParams.set('signature', 'f'.repeat(64)))).toBe(false);
    expect(tampered((u) => u.searchParams.set('signature', 'not hex'))).toBe(false);
    // Reordering the query is no tampering: it is signed sorted.
    const other = new URL(signer(KEY).signedRoute('unsubscribe', { id: 7, list: 'news' }, { expiresIn: 60 }), 'http://x');
    const reused = new URL(`/email/verify/7/abc?${other.searchParams}`, 'http://x');
    expect(signer(KEY).hasValidSignature(reused)).toBe(false); // the signature of another route
  });

  it('expires — by the app clock', () => {
    clock.freeze();
    const url = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 60 });
    clock.travel({ seconds: 59 });
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    clock.travel({ seconds: 2 });
    expect(signer(KEY).hasValidSignature(url)).toBe(false);
  });

  it('writes the same expiry for a duration object as for the seconds', () => {
    clock.freeze();
    const expires = (url: string) => new URL(url, 'http://x').searchParams.get('expires');
    const named = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: { minutes: 60 } });
    expect(expires(named)).toBe(expires(signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 3600 })));
    expect(expires(named)).toBe(String(Math.floor(clock.now() / 1000) + 3600));
    expect(expires(signer(KEY).signedPath('/x', { expiresIn: { days: 7 } }))).toBe(String(Math.floor(clock.now() / 1000) + 7 * 86_400));
  });

  it('rounds the expiry down to a whole second, never up', () => {
    clock.freeze(1_700_000_000_000);
    const url = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: { seconds: 1, milliseconds: 900 } });
    expect(new URL(url, 'http://x').searchParams.get('expires')).toBe(String(1_700_000_001));
  });

  it('refuses a string as the time span: no link, not even one without an expiry', () => {
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: '60m' as any })).toThrow(TypeError);
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: '60m' as any })).toThrow('write `{ minutes: 60 }`');
    expect(() => signer(KEY).signedPath('/x', { expiresIn: '7d' as any })).toThrow('write `{ days: 7 }`');
    // @ts-expect-error — a string is no time span; it is `{ days: 7 }`
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: '7d' })).toThrow(TypeError);
    // @ts-expect-error — the calendar decides how long a week is
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: { weeks: 1 } })).toThrow(TypeError);
  });

  it('needs an expiry: signedRoute() and signedPath() without expiresIn do not type-check and throw', () => {
    // @ts-expect-error — no options at all
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' })).toThrow('expiresIn');
    // @ts-expect-error — options without expiresIn
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { base: 'https://app.example' })).toThrow('expiresIn');
    // @ts-expect-error — undefined is no time span
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: undefined })).toThrow('expiresIn');
    // @ts-expect-error — no options at all
    expect(() => signer(KEY).signedPath('/x')).toThrow('expiresIn');
    // @ts-expect-error — options without expiresIn
    expect(() => signer(KEY).signedPath('/x', { query: { a: 'b' } })).toThrow('expiresIn');
    // @ts-expect-error — the old method is gone
    expect(signer(KEY).temporarySignedRoute).toBeUndefined();
  });

  it('refuses an expiry that is over before the link is made', () => {
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 0 })).toThrow(RangeError);
    expect(() => signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: -60 })).toThrow(RangeError);
    expect(() => signer(KEY).signedPath('/x', { expiresIn: { milliseconds: 500 } })).toThrow(RangeError);
    // @ts-expect-error — the parameters are required
    expect(() => signer(KEY).foreverSignedRoute('unsubscribe')).toThrow('needs its parameters');
  });

  it('signs a link without expiry only with foreverSignedRoute()', () => {
    const url = signer(KEY).foreverSignedRoute('verify', { id: 7, hash: 'abc', ref: 'mail' });
    expect(url).toMatch(/^\/email\/verify\/7\/abc\?ref=mail&signature=[0-9a-f]{64}$/);
    expect(new URL(url, 'http://x').searchParams.has('expires')).toBe(false);
    expect(signer(KEY).hasValidSignature(url, { forever: true })).toBe(true);
    clock.travel({ days: 3650 });
    expect(signer(KEY).hasValidSignature(url, { forever: true })).toBe(true);
    expect(signer(KEY).foreverSignedRoute('verify', { id: 7, hash: 'abc' }, { base: 'https://app.example' })).toMatch(/^https:\/\/app\.example\/email\/verify\/7\/abc\?signature=/);
    expect(() => signer(KEY).foreverSignedRoute('nope', {})).toThrow('[marmeon:H4]');
    expect(() => signer(KEY).foreverSignedRoute('verify', { id: 7, hash: 'abc', expires: 1 })).toThrow('"expires" is reserved');
  });

  it('hasValidSignature() refuses a link without expires unless forever is set; an expired link never passes', () => {
    clock.freeze();
    const forever = signer(KEY).foreverSignedRoute('verify', { id: 7, hash: 'abc' });
    const expiring = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 60 });
    expect(signer(KEY).hasValidSignature(forever)).toBe(false);
    expect(signer(KEY).hasValidSignature(forever, {})).toBe(false);
    expect(signer(KEY).hasValidSignature(forever, { forever: false })).toBe(false);
    expect(signer(KEY).hasValidSignature(forever, { forever: true })).toBe(true);
    expect(signer(KEY).hasValidSignature(expiring)).toBe(true);
    expect(signer(KEY).hasValidSignature(expiring, { forever: true })).toBe(true);
    clock.travel({ seconds: 61 });
    expect(signer(KEY).hasValidSignature(expiring)).toBe(false);
    expect(signer(KEY).hasValidSignature(expiring, { forever: true })).toBe(false);
    expect(signer(KEY).hasValidSignature(forever, { forever: true })).toBe(true);
    // @ts-expect-error — forever is a boolean
    expect(signer(KEY).hasValidSignature(forever, { forever: 'yes' })).toBe(false);
    // @ts-expect-error — forever is a boolean
    expect(signed({ forever: 1 })).toBe(ValidateSignature);
  });

  it('keeps verifying links signed before: the signature and the query are unchanged', () => {
    const fixed = new TestClock();
    fixed.freeze(1_800_000_000_000);
    const fixture = new UrlSigner(router, { key: Buffer.alloc(32, 7), previousKeys: [] } as unknown as EncryptionConfig, fixed);
    const withExpiry = '/email/verify/7/abc?ref=mail&expires=1900000000&signature=94b1b886e19ca3c1f3405f5b5e6d67dfba7df886bd0a2e87bc4b5a46b2137593';
    const forever = '/email/verify/7/abc?signature=9922f45ba375c7653f06ff1747985ef21ecde5d0af26ae74f075748dc3e59bbb';
    expect(fixture.hasValidSignature(withExpiry)).toBe(true);
    expect(fixture.hasValidSignature(forever, { forever: true })).toBe(true);
    // The new API writes the very same bytes.
    expect(fixture.signedRoute('verify', { id: 7, hash: 'abc', ref: 'mail' }, { expiresIn: 100_000_000 })).toBe(withExpiry);
    expect(fixture.foreverSignedRoute('verify', { id: 7, hash: 'abc' })).toBe(forever);
    // A doubled `expires` is refused, even when both are signed.
    expect(fixture.hasValidSignature(`${withExpiry}&expires=1900000001`)).toBe(false);
  });

  it('signs a path without a route name: query and expiry signed, path as given', () => {
    clock.freeze();
    const url = signer(KEY).signedPath('/_marmeon/storage/local/exports/7%20a.json', { query: { filename: 'export.json' }, expiresIn: 300 });
    expect(url).toMatch(/^\/_marmeon\/storage\/local\/exports\/7%20a\.json\?filename=export\.json&expires=\d+&signature=[0-9a-f]{64}$/);
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    expect(signer(KEY).hasValidSignature(url.replace('/local/', '/public/'))).toBe(false);
    expect(signer(KEY).hasValidSignature(url.replace('filename=export.json', 'filename=export.html'))).toBe(false);
    expect(signer(KEY).signedPath('/x', { expiresIn: 60, base: 'https://app.example' })).toMatch(/^https:\/\/app\.example\/x\?expires=\d+&signature=/);
    expect(() => signer(KEY).signedPath('/x', { query: { expires: '9' }, expiresIn: 60 })).toThrow('"expires" is reserved');
    expect(() => signer(KEY).signedPath('x?y', { expiresIn: 60 })).toThrow('without query');
    clock.travel({ seconds: 301 });
    expect(signer(KEY).hasValidSignature(url)).toBe(false);
  });

  it('keeps links of a previous key valid (rotation), refuses foreign keys', () => {
    const old = generateKey();
    const url = signer(old).signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: 60 });
    expect(signer(KEY, [old]).hasValidSignature(url)).toBe(true);
    expect(signer(KEY).hasValidSignature(url)).toBe(false);
  });

  it('signs with a key of its own — an HMAC with APP_KEY itself is not accepted', () => {
    const path = '/email/verify/7/abc';
    const withAppKey = createHmac('sha256', keyOf(KEY)).update(`${path}?`).digest('hex');
    expect(signer(KEY).hasValidSignature(`${path}?signature=${withAppKey}`)).toBe(false);
  });
});

describe('signed() middleware', () => {
  it('lets valid links through and answers everything else with 403 — from the app’s own signer', async () => {
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: [defineModule({ name: 'signed', routes })],
    }, { env: { APP_KEY: KEY, LOG_LEVEL: 'silent' } });
    const appSigner = application.container.make(UrlSigner);
    const middleware = new ValidateSignature(appSigner);
    const url = appSigner.signedRoute('verify', { id: 7, hash: 'abc' }, { expiresIn: { minutes: 5 }, base: 'https://app.example' });
    const run = (href: string) =>
      Promise.resolve()
        .then(() => middleware.handle({ request: new Request(href) } as never, async () => new Response('ok')))
        .then((response) => response.status, (error: { status: number; message: string }) => `${error.status} ${error.message}`);
    expect(await run(url)).toBe(200);
    expect(await run(url.replace('https://app.example', 'http://internal:8080'))).toBe(200); // the host is not signed
    expect(await run(url.replace('/7/', '/8/'))).toBe('403 Invalid signature.');
    expect(await run(url.replace(/\?.*/, ''))).toBe('403 Invalid signature.');
    expect(signed()).toBe(ValidateSignature);
  });

  it('refuses a link without expires, unless the route says signed({ forever: true }); an expired link never passes', async () => {
    const appSigner = signer(KEY);
    const strict = new (signed())(appSigner);
    const lenient = new (signed({ forever: true }))(appSigner);
    const run = (middleware: ValidateSignature, href: string) =>
      Promise.resolve()
        .then(() => middleware.handle({ request: new Request(href) } as never, async () => new Response('ok')))
        .then((response) => response.status, (error: { status: number }) => error.status);
    clock.freeze();
    const forever = appSigner.foreverSignedRoute('unsubscribe', { id: 7 }, { base: 'https://app.example' });
    const expiring = appSigner.signedRoute('unsubscribe', { id: 7 }, { expiresIn: 60, base: 'https://app.example' });
    expect(await run(strict, forever)).toBe(403);
    expect(await run(lenient, forever)).toBe(200);
    expect(await run(strict, expiring)).toBe(200);
    expect(await run(lenient, expiring)).toBe(200);
    clock.travel({ seconds: 61 });
    expect(await run(strict, expiring)).toBe(403);
    expect(await run(lenient, expiring)).toBe(403);
    expect(await run(lenient, forever)).toBe(200);
  });
});

describe('signed({ withoutCsrf: true })', () => {
  it('is marked for the CSRF check, with the policy on expiry it checks by; no other middleware is', () => {
    expect(withoutCsrfSignature(signed({ withoutCsrf: true }))).toEqual({ forever: false });
    expect(withoutCsrfSignature(signed({ withoutCsrf: true, forever: true }))).toEqual({ forever: true });
    for (const layer of [signed(), signed({ forever: true }), ValidateSignature, class extends (signed({ withoutCsrf: true }) as unknown as new () => object) {}, { handle: () => undefined }]) {
      expect(withoutCsrfSignature(layer)).toBeUndefined();
    }
  });
});
