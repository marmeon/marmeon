import { createApplication, defineModule, html } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, securityHeaders } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

describe('createHttpKernel — a string is text, only Html is HTML', async () => {
  const input = (ctx: { request: Request }) => new URL(ctx.request.url).searchParams.get('q') ?? '';
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    middleware: { global: [securityHeaders()] },
    modules: [
      defineModule({
        name: 'echo',
        routes: openRoutes((Route) => {
          Route.get('/text', (ctx) => input(ctx));
          Route.get('/html', (ctx) => html`<p>${input(ctx)}</p>`);
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);
  const q = encodeURIComponent('<script>alert(1)</script>');

  it('sends a string as text/plain with nosniff and the body unchanged', async () => {
    const response = await app.request(`/text?q=${q}`);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('<script>alert(1)</script>');
  });

  it('sends Html as text/html with the input escaped', async () => {
    const response = await app.request(`/html?q=${q}`);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
});
