import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const routes = openRoutes((Route) => {
  Route.get('/badge.png', () => new Response(new Uint8Array([...SIGNATURE, 0xff, 0xfe]), { headers: { 'content-type': 'image/png' } }));
  Route.get('/greeting', () => 'Grüße');
});

const makeApp = () =>
  createTestApp(
    {
      root: tempDir('marmeon-testing-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [defineModule({ name: 'badges', routes })],
    },
    { env: { APP_KEY: generateKey() } },
  );

describe('TestResponse.bytes', () => {
  it('gives a binary body untouched, which text would have mangled', async () => {
    const app = await makeApp();
    const response = await app.get('/badge.png').assertOk().assertHeader('content-type', 'image/png');
    expect(Array.from(response.bytes())).toEqual([...SIGNATURE, 0xff, 0xfe]);
  });

  it('gives a copy, so changing it leaves the response as it is', async () => {
    const response = await (await makeApp()).get('/badge.png');
    response.bytes().fill(0);
    expect(response.bytes()[0]).toBe(0x89);
  });

  it('is typed over an ArrayBuffer, so a Blob or a digest takes it', async () => {
    const response = await (await makeApp()).get('/badge.png');
    const blob = new Blob([response.bytes()], { type: 'image/png' });
    const digest = await crypto.subtle.digest('SHA-256', response.bytes());
    expect(blob.size).toBe(SIGNATURE.length + 2);
    expect(digest.byteLength).toBe(32);
  });

  it('leaves the text body as it was', async () => {
    const response = await (await makeApp()).get('/greeting');
    expect(response.body).toBe('Grüße');
    expect(new TextDecoder().decode(response.bytes())).toBe('Grüße');
    response.assertSee('Grüße');
  });
});
