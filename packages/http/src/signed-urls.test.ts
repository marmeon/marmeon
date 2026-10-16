import { createHmac } from 'node:crypto';
import { createApplication, defineModule } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionConfig, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, Router } from '@marmeon/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpServiceProvider } from './provider.ts';
import { signed, UrlSigner, ValidateSignature } from './signed-urls.ts';

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
  it('signs path and query; extra parameters go into the query; absolute with a base', () => {
    const url = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc', ref: 'mail' });
    expect(url).toMatch(/^\/email\/verify\/7\/abc\?ref=mail&signature=[0-9a-f]{64}$/);
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    const absolute = signer(KEY).signedRoute('verify', { id: 7, hash: 'abc' }, { base: 'https://app.example' });
    expect(absolute).toMatch(/^https:\/\/app\.example\/email\/verify\/7\/abc\?signature=/);
    expect(signer(KEY).hasValidSignature(absolute)).toBe(true);
  });

  it('a changed parameter, a changed expiry, a signature from another route — all invalid', () => {
    const url = new URL(signer(KEY).temporarySignedRoute('verify', { id: 7, hash: 'abc' }, '60m'), 'http://x');
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
    const other = new URL(signer(KEY).signedRoute('unsubscribe', { id: 7, list: 'news' }), 'http://x');
    const reused = new URL(`/email/verify/7/abc?${other.searchParams}`, 'http://x');
    expect(signer(KEY).hasValidSignature(reused)).toBe(false); // the signature of another route
  });

  it('expires — by the app clock', () => {
    clock.freeze();
    const url = signer(KEY).temporarySignedRoute('verify', { id: 7, hash: 'abc' }, 60);
    clock.travel({ seconds: 59 });
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    clock.travel({ seconds: 2 });
    expect(signer(KEY).hasValidSignature(url)).toBe(false);
  });

  it('signs a path without a route name: query and expiry signed, path as given', () => {
    clock.freeze();
    const url = signer(KEY).signedPath('/_marmeon/storage/local/exports/7%20a.json', { query: { filename: 'export.json' }, expiresIn: 300 });
    expect(url).toMatch(/^\/_marmeon\/storage\/local\/exports\/7%20a\.json\?filename=export\.json&expires=\d+&signature=[0-9a-f]{64}$/);
    expect(signer(KEY).hasValidSignature(url)).toBe(true);
    expect(signer(KEY).hasValidSignature(url.replace('/local/', '/public/'))).toBe(false);
    expect(signer(KEY).hasValidSignature(url.replace('filename=export.json', 'filename=export.html'))).toBe(false);
    expect(signer(KEY).signedPath('/x', { base: 'https://app.example' })).toMatch(/^https:\/\/app\.example\/x\?signature=/);
    expect(() => signer(KEY).signedPath('/x', { query: { expires: '9' } })).toThrow('"expires" is reserved');
    expect(() => signer(KEY).signedPath('x?y')).toThrow('without query');
    clock.travel({ seconds: 301 });
    expect(signer(KEY).hasValidSignature(url)).toBe(false);
  });

  it('keeps links of a previous key valid (rotation), refuses foreign keys', () => {
    const old = generateKey();
    const url = signer(old).signedRoute('verify', { id: 7, hash: 'abc' });
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
    const url = appSigner.temporarySignedRoute('verify', { id: 7, hash: 'abc' }, '5m', { base: 'https://app.example' });
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
});
