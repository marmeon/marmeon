import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, json, type HttpContext } from '@marmeon/http';
import {
  ACTION_HEADER,
  LOCATION_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PROTOCOL_VERSION,
  REGION_HEADER,
  RELOAD_HEADER,
  UPLOAD_HEADER,
  VALIDATE_HEADER,
  VERSION_HEADER,
} from '@marmeon/http/protocol';
import type { Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { protocolGate } from './protocol-gate.ts';
import { ServerServiceProvider } from './provider.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('protocol gate', async () => {
  const ran = { middleware: 0, controller: 0 };
  /** What a session and a CSRF check do: run first and set a cookie. The gate must come before it. */
  class Starting {
    async handle(ctx: HttpContext, next: Next<{}>) {
      ran.middleware++;
      ctx.cookies.set('session', 'started');
      return next();
    }
  }
  const handler = () => {
    ran.controller++;
    return json({ ran: true });
  };
  const routes = openRoutes((Route) => {
    Route.middleware(Starting).get('/things', handler);
    Route.middleware(Starting).post('/things', handler);
    Route.middleware(Starting).put('/things', handler);
    Route.middleware(Starting).patch('/things', handler);
    Route.middleware(Starting).delete('/things', handler);
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'gate', routes })],
  }, { env: { APP_KEY: generateKey() } });
  const kernel = createHttpKernel(application);
  const send = (method: string, headers: Record<string, string>) => {
    ran.middleware = 0;
    ran.controller = 0;
    return kernel.request('/things?page=2', { method, headers: { referer: 'http://localhost/settings?tab=1', ...headers } });
  };

  // Every way a request says it speaks the protocol — and the versions it can name, or none at all.
  const protocolRequests: Record<string, Record<string, string>> = {
    'the old value': { [PAGE_HEADER]: 'true' },
    'another version': { [PAGE_HEADER]: '2' },
    'an empty version': { [PAGE_HEADER]: '' },
    'a merged value': { [PAGE_HEADER]: `${PROTOCOL_VERSION}, ${PROTOCOL_VERSION}` },
    'an action without a version': { [ACTION_HEADER]: 'true', accept: 'application/json' },
    'a live validation without a version': { [VALIDATE_HEADER]: 'name', accept: 'application/json' },
    'an island without a version': { [REGION_HEADER]: 'island' },
    'a partial reload without a version': { [PARTIAL_COMPONENT_HEADER]: 'users/Show' },
    'an upload without a version': { [UPLOAD_HEADER]: 'avatar' },
    'the asset version alone': { [VERSION_HEADER]: 'abc' },
    'an action of another version': { [ACTION_HEADER]: 'true', [PAGE_HEADER]: '2' },
  };

  for (const [what, headers] of Object.entries(protocolRequests)) {
    it.each(METHODS)(`${what}: %s answers 409 and runs no middleware and no controller`, async (method) => {
      const response = await send(method, headers);
      expect(response.status).toBe(409);
      expect([ran.middleware, ran.controller]).toEqual([0, 0]);
      expect(response.headers.get(RELOAD_HEADER)).toBe('version');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe(PAGE_HEADER);
      // No session, no cookie, no CSRF verdict (419): the answer has no side effect.
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.text()).toBe('');
    });
  }

  it('sends a GET to its own URL, and a write to the page it came from', async () => {
    expect((await send('GET', { [PAGE_HEADER]: 'true' })).headers.get(LOCATION_HEADER)).toBe('http://localhost/things?page=2');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await send(method, { [PAGE_HEADER]: 'true' })).headers.get(LOCATION_HEADER)).toBe('http://localhost/settings?tab=1');
    }
  });

  it('sends an action, a validation, an upload or an island by GET to the page it came from — their URL is no page', async () => {
    const kinds: Record<string, string>[] = [{ [ACTION_HEADER]: 'true' }, { [ACTION_HEADER]: '1' }, { [VALIDATE_HEADER]: 'name' }, { [UPLOAD_HEADER]: 'avatar' }, { [REGION_HEADER]: 'island' }];
    for (const headers of kinds) {
      const response = await send('GET', { ...headers, [PAGE_HEADER]: 'true' });
      expect([response.status, response.headers.get(LOCATION_HEADER)]).toEqual([409, 'http://localhost/settings?tab=1']);
    }
    // Without a Referer there is nothing to name but the start page; a layer's GET is a page of its own.
    expect((await kernel.request('/things', { headers: { [ACTION_HEADER]: 'true' } })).headers.get(LOCATION_HEADER)).toBe('/');
    expect((await send('GET', { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'layer' })).headers.get(LOCATION_HEADER)).toBe('http://localhost/things?page=2');
  });

  it('answers with nosniff', async () => {
    expect((await send('POST', { [PAGE_HEADER]: 'true' })).headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never sends a write to a foreign or unreadable Referer, nor to a missing one', async () => {
    for (const referer of ['https://evil.example/x', 'http://localhost.evil.example/', 'not a url', 'javascript:alert(1)']) {
      const response = await send('POST', { [PAGE_HEADER]: 'true', referer });
      expect([response.status, response.headers.get(LOCATION_HEADER)]).toEqual([409, '/']);
    }
    const none = await kernel.request('/things', { method: 'POST', headers: { [PAGE_HEADER]: 'true' } });
    expect(none.headers.get(LOCATION_HEADER)).toBe('/');
  });

  it('lets the supported version through — every method, and an action', async () => {
    for (const method of METHODS) {
      const response = await send(method, { [PAGE_HEADER]: PROTOCOL_VERSION });
      expect([response.status, ran.controller]).toEqual([200, 1]);
    }
    const action = await send('POST', { [PAGE_HEADER]: PROTOCOL_VERSION, [ACTION_HEADER]: 'true', accept: 'application/json' });
    expect([action.status, ran.controller]).toEqual([200, 1]);
  });

  it('leaves a request without any protocol header alone: a document load, an API client', async () => {
    for (const method of METHODS) {
      const response = await send(method, { accept: 'text/html' });
      expect([response.status, ran.controller]).toEqual([200, 1]);
    }
    expect((await send('GET', { authorization: 'Bearer x' })).status).toBe(200);
  });

  describe('the set of supported versions', () => {
    const supported = new Set(['1', '2']);
    const gate = (headers: Record<string, string>) => protocolGate(new Request('http://localhost/x', { method: 'POST', headers }), supported);

    it('lets 1 and 2 through and refuses 3, the old value and none', () => {
      expect(gate({ [PAGE_HEADER]: '1' })).toBeUndefined();
      expect(gate({ [PAGE_HEADER]: '2' })).toBeUndefined();
      expect(gate({ [PAGE_HEADER]: '3' })?.status).toBe(409);
      expect(gate({ [PAGE_HEADER]: 'true' })?.status).toBe(409);
      expect(gate({ [ACTION_HEADER]: 'true' })?.status).toBe(409);
    });
  });
});
