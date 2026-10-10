import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import {
  ACTION_HEADER,
  ACTION_REDIRECT_HEADER,
  ClearClientHistory,
  ClientHistory,
  Controller,
  defineRequest,
  HttpServiceProvider,
  json,
  LOCATION_HEADER,
  view,
  type ContextOf,
  type HttpContext,
} from '@marmeon/http';
import { defineRoutes, type Next } from '@marmeon/router';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

const ACTION = { [ACTION_HEADER]: 'true', accept: 'application/json', 'content-type': 'application/json' };

describe('createHttpKernel — actions', async () => {
  const StoreRequest = defineRequest({ schema: v.object({ label: v.pipe(v.string(), v.minLength(1, 'The label is required.')) }) });
  class Cached {
    async handle(_ctx: HttpContext, next: Next<{}>) {
      const response = await next();
      const cached = new Response(response.body, response);
      cached.headers.set('cache-control', 'public, max-age=3600');
      return cached;
    }
  }
  class StoreLinkController extends Controller {
    static request = StoreRequest;
    handle(ctx: ContextOf<typeof StoreRequest>) {
      return this.redirect(`/links?added=${ctx.body.label}`);
    }
  }
  const routes = defineRoutes((Route) => {
    Route.delete('/links/:link', (ctx: HttpContext<{}, { link: string }>) => json({ deleted: Number(ctx.params.link) })).name('links.destroy');
    Route.post('/links', StoreLinkController).name('links.store');
    Route.middleware(Cached).post('/cached', () => json({ at: 'now' })).name('cached');
    Route.post('/page', () => view('links/Index', {})).name('page');
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'actions', routes })],
  });
  const app = createHttpKernel(application, { debug: true });

  it('answers with the JSON of `json()` — never cached: no-store, whatever the route set, and Vary on the action header', async () => {
    const response = await app.request('/links/7', { method: 'DELETE', headers: ACTION });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 7 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain(ACTION_HEADER);
    const cached = await app.request('/cached', { method: 'POST', headers: ACTION });
    expect(cached.headers.get('cache-control')).toBe('no-store');
    // The same route without the action header keeps its own Cache-Control.
    expect((await app.request('/cached', { method: 'POST' })).headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('reports a redirect instead of answering it: 204 with x-marmeon-redirect — nothing for fetch to follow', async () => {
    const response = await app.request('/links', { method: 'POST', headers: ACTION, body: JSON.stringify({ label: 'Blog' }) });
    expect(response.status).toBe(204);
    expect(response.headers.get(ACTION_REDIRECT_HEADER)).toBe('/links?added=Blog');
    expect(response.headers.get('location')).toBeNull();
    // Without the header (a form, no JavaScript): the redirect as it is.
    expect((await app.request('/links', { method: 'POST', body: JSON.stringify({ label: 'Blog' }), headers: { 'content-type': 'application/json' } })).status).toBe(303);
  });

  it('answers invalid input with 422 and the field errors — never a redirect back to the form', async () => {
    const response = await app.request('/links', { method: 'POST', headers: ACTION, body: JSON.stringify({ label: '' }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: { label: ['The label is required.'] } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses to answer an action with a page: 406, JSON', async () => {
    const response = await app.request('/page', { method: 'POST', headers: ACTION });
    expect(response.status).toBe(406);
    expect(response.headers.get('content-type')).toContain('json');
    expect(((await response.json()) as { message: string }).message).toMatch(/is a page — an action \(useAction\) gets data/);
  });
});

describe('ClearClientHistory and actions', () => {
  it('signing out through an action is a 409 to the page it was sent from — the client leaves its memory behind', async () => {
    const history = new ClientHistory();
    history.clear();
    const middleware = new ClearClientHistory(history);
    const request = new Request('https://app.test/logout', { method: 'POST', headers: { [ACTION_HEADER]: 'true', referer: 'https://app.test/settings/tokens' } });
    const response = await middleware.handle({ request } as HttpContext, async () => Response.json({ ok: true }));
    expect(response.status).toBe(409);
    expect(response.headers.get(LOCATION_HEADER)).toBe('/settings/tokens');
    const redirected = await middleware.handle({ request } as HttpContext, async () => new Response(null, { status: 303, headers: { location: '/login' } }));
    expect(redirected.headers.get(LOCATION_HEADER)).toBe('/login');
    // Another site's Referer is not followed.
    const foreign = new Request('https://app.test/logout', { method: 'POST', headers: { [ACTION_HEADER]: 'true', referer: 'https://evil.test/' } });
    expect((await middleware.handle({ request: foreign } as HttpContext, async () => Response.json({}))).headers.get(LOCATION_HEADER)).toBe('/');
  });
});
