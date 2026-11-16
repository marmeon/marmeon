import { createApplication, defineModule, Translator } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, conflict, HttpServiceProvider } from '@marmeon/http';
import { ACTION_HEADER, CONFLICT_HEADER, LOCATION_HEADER, PAGE_HEADER, protocolHeaders } from '@marmeon/http/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

class SaveController extends Controller {
  handle() {
    return conflict({ version: 3 });
  }
}
class NamedController extends Controller {
  handle() {
    return conflict({ version: 4 }, { message: 'notes.stale' });
  }
}

class LiteralController extends Controller {
  handle() {
    return conflict({ version: 5 }, { message: 'Edited by Ada.' });
  }
}

const GERMAN: Record<string, string> = { 'marmeon.errors.conflict': 'Jemand anderes hat das inzwischen geändert.', 'notes.stale': 'Die Notiz ist veraltet.' };

async function kernel(translated: boolean) {
  const routes = openRoutes((Route) => {
    Route.put('/notes/1', SaveController).name('notes.update');
    Route.put('/notes/2', NamedController).name('notes.named');
    Route.put('/notes/3', LiteralController).name('notes.literal');
    Route.get('/notes/get', SaveController).name('notes.get');
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'conflicts', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
  if (translated) {
    application.container.scoped(
      Translator,
      () => ({ locale: 'de', has: (key: string) => key in GERMAN, text: (key: string, _params: unknown, fallback?: string) => GERMAN[key] ?? fallback ?? key }) as never,
    );
  }
  return createHttpKernel(application, { debug: true });
}

const ACTION = { ...protocolHeaders(), [ACTION_HEADER]: 'true', accept: 'application/json' };

describe('a controller answering conflict(current)', () => {
  it('answers an action with 409, the conflict header and { message, current } — never a location, never cached', async () => {
    const app = await kernel(false);
    const response = await app.request('/notes/1', { method: 'PUT', headers: ACTION });
    expect(response.status).toBe(409);
    expect(response.headers.get(CONFLICT_HEADER)).toBe('1');
    expect(response.headers.get(LOCATION_HEADER)).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const vary = (response.headers.get('vary') ?? '').toLowerCase().split(/\s*,\s*/);
    expect(vary).toEqual(expect.arrayContaining(['accept', PAGE_HEADER]));
    expect(await response.json()).toEqual({ message: 'Someone else changed this in the meantime.', current: { version: 3 } });
  });

  it('speaks the request\'s language: the framework text, or the key the controller named', async () => {
    const app = await kernel(true);
    expect(await (await app.request('/notes/1', { method: 'PUT', headers: ACTION })).json()).toEqual({ message: 'Jemand anderes hat das inzwischen geändert.', current: { version: 3 } });
    expect(await (await app.request('/notes/2', { method: 'PUT', headers: ACTION })).json()).toEqual({ message: 'Die Notiz ist veraltet.', current: { version: 4 } });
  });

  it('sends a literal message as it is — with a translator that does not know it, and without one', async () => {
    const expected = { message: 'Edited by Ada.', current: { version: 5 } };
    expect(await (await (await kernel(true)).request('/notes/3', { method: 'PUT', headers: ACTION })).json()).toEqual(expected);
    expect(await (await (await kernel(false)).request('/notes/3', { method: 'PUT', headers: ACTION })).json()).toEqual(expected);
  });

  it('answers an API client with no Accept, or any type, with the 409 — the same JSON, no location', async () => {
    const app = await kernel(false);
    for (const headers of [{}, { accept: '*/*' }, { accept: 'application/json' }]) {
      const response = await app.request('/notes/1', { method: 'PUT', headers });
      expect(response.status).toBe(409);
      expect(response.headers.get(CONFLICT_HEADER)).toBe('1');
      expect(response.headers.get(LOCATION_HEADER)).toBeNull();
      expect(await response.json()).toEqual({ message: 'Someone else changed this in the meantime.', current: { version: 3 } });
    }
  });

  it('refuses a page request with 406 where there is no session to keep the conflict — a visit, a form, a client that accepts HTML: never a 500, a location or a 409', async () => {
    const app = await kernel(false);
    const message = 'A conflict goes back to the form that sent it, which needs a POST, PUT, PATCH or DELETE in a route with a session (the web group); this request is a GET, or its route has no session — return conflict(…) only from a route that those call, or one an action or API client calls.';
    const visit = await app.request('/notes/1', { method: 'PUT', headers: protocolHeaders() });
    expect(visit.status).toBe(406);
    expect(visit.headers.get(CONFLICT_HEADER)).toBeNull();
    expect(visit.headers.get(LOCATION_HEADER)).toBeNull();
    expect(((await visit.json()) as { props: { message: string } }).props.message).toBe(message);
    const withJson = await app.request('/notes/1', { method: 'PUT', headers: { ...protocolHeaders(), accept: 'application/json' } });
    expect(withJson.status).toBe(406);
    for (const accept of ['text/html,application/xhtml+xml,*/*;q=0.8', 'application/xhtml+xml']) {
      const form = await app.request('/notes/1', { method: 'PUT', headers: { accept } });
      expect(form.status).toBe(406);
      expect(form.headers.get(CONFLICT_HEADER)).toBeNull();
      expect(form.headers.get(LOCATION_HEADER)).toBeNull();
      expect(await form.text()).toContain(message);
    }
  });

  it('answers a GET with 406 whatever it accepts — a prefetch or a link never goes back and never writes', async () => {
    const app = await kernel(false);
    for (const headers of [protocolHeaders(), { accept: 'text/html' }, { ...protocolHeaders(), purpose: 'prefetch' }]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await app.request('/notes/get', { method, headers });
        expect(response.status, `${method} ${JSON.stringify(headers)}`).toBe(406);
        expect(response.headers.get(LOCATION_HEADER)).toBeNull();
      }
    }
    // An API client's GET still gets the 409.
    expect((await app.request('/notes/get', { headers: { accept: 'application/json' } })).status).toBe(409);
  });
});
