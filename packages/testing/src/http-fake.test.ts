import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { FetchError, FetchServiceProvider, HttpClient, type FetchTransport } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-http-'),
  discover: false,
  providers: [FetchServiceProvider],
  modules: [defineModule({ name: 'http-fake' })],
};

describe('app.http', () => {
  it('is the HttpClient of the container, a fake that answers from replies', async () => {
    await using app = await createTestApp(definition);
    expect(app.http).toBeInstanceOf(HttpClientFake);
    expect(app.make(HttpClient)).toBe(app.http);
    app.http.respond('https://hooks.example.com/pay', new Response('paid', { status: 202 }));
    const response = await app.make(HttpClient).fetch('https://hooks.example.com/pay', { method: 'POST', json: { id: 1 } });
    expect([response.status, await response.text()]).toEqual([202, 'paid']);
    app.http.assertSentCount(1);
  });

  it('judges addresses with the ranges FETCH_ALLOWED_ADDRESSES names', async () => {
    await using app = await createTestApp(definition, { env: { FETCH_ALLOWED_ADDRESSES: '10.20.0.0/16' } });
    app.http.respond(/.*/, new Response('ok'));
    expect((await app.make(HttpClient).fetch('http://10.20.1.1/')).status).toBe(200);
    const refused = await app.make(HttpClient).fetch('http://169.254.169.254/').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FetchError);
    expect((refused as FetchError).reason).toBe('refused');
    app.http.assertSentCount(1);
  });

  it("is not bound with http: 'real': the container keeps the real client and app.http says why", async () => {
    await using app = await createTestApp(definition, { http: 'real' });
    expect(app.make(HttpClient)).not.toBeInstanceOf(HttpClientFake);
    expect(() => app.http).toThrow("app.http needs @marmeon/fetch in the app (and not createTestApp(…, { http: 'real' })).");
  });

  it('is absent from an app without the package, which still starts', async () => {
    await using app = await createTestApp({ root: tempDir('marmeon-testing-http-none-'), discover: false, modules: [defineModule({ name: 'no-http' })] });
    expect(app.container.has(HttpClient)).toBe(false);
    expect(() => app.http).toThrow('app.http needs @marmeon/fetch');
  });

  it('keeps the boot checks under the fake: a driver nobody brought and a range that is none stop the start with S9', async () => {
    await expect(createTestApp(definition, { env: { FETCH_DRIVER: 'typo' } })).rejects.toThrow(/S9.*FETCH_DRIVER=typo is not a fetch driver/);
    await expect(createTestApp(definition, { env: { FETCH_ALLOWED_ADDRESSES: 'not-a-range' } })).rejects.toThrow(/S9.*FETCH_ALLOWED_ADDRESSES/);
  });

  it('builds the transport a provider brings under the fake, so a factory that fails stops the start', async () => {
    const send: FetchTransport['send'] = () => Promise.reject(new Error('never sent'));
    const made = vi.fn(() => ({ send }));
    class EgressProvider {
      static fetchDrivers = { egress: made };
    }
    await using app = await createTestApp({ ...definition, providers: [FetchServiceProvider, EgressProvider] }, { env: { FETCH_DRIVER: 'egress' } });
    expect(made).toHaveBeenCalledTimes(1);
    expect(app.http).toBeInstanceOf(HttpClientFake);
    const broken = { ...definition, providers: [FetchServiceProvider, class { static fetchDrivers = { egress: () => ({}) as FetchTransport }; }] };
    await expect(createTestApp(broken, { env: { FETCH_DRIVER: 'egress' } })).rejects.toThrow(/S9.*must return a FetchTransport/);
  });
});
