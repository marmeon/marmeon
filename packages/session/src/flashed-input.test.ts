import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, RedirectResult, ValidationError } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { SessionStore } from './store.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { wrapped } from './test-helpers/wrapped-store.ts';

const MAX = 64 * 1024;

const routes = openRoutes((Route) => {
  // What a list rule makes of 30,000 invalid items: one message per item, and the posted list as input.
  Route.post('/tags', async (ctx: { request: Request }) => {
    const { tags } = (await ctx.request.json()) as { tags: unknown[] };
    throw new ValidationError({ tags: tags.map((_, index) => `Item ${index} must be a string.`), email: ['Required.'] }, { tags, email: 'ada@example.com' });
  });
});

const FIELDS = { name: 'Ada', national_id: 'X-1234', person: { National_ID: 'Y-5678', city: 'Z' } };

const fieldRoutes = openRoutes((Route) => {
  Route.post('/invalid', () => {
    throw new ValidationError({ name: ['Required.'] }, FIELDS);
  });
  Route.post('/back', () => new RedirectResult('/form').withInput(FIELDS));
});

describe('a form and the names an app added to the redactor', () => {
  it.each(['/invalid', '/back'])('%s leaves the added field out of the stored session', async (path) => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const store = wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) });
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      redact: { keys: ['national_id'] },
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
      modules: [defineModule({ name: 'forms', routes: fieldRoutes })],
    }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent' }, override: (container) => void container.instance(SessionStore, store) });

    const response = await createHttpKernel(application).request(path, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' } });
    expect(response.status).toBe(303);
    expect(written).toHaveLength(1);
    const payload = written[0]!;
    expect(payload, payload).not.toMatch(/national_id|X-1234|Y-5678/i);
    expect(payload).toContain('Ada');
    expect(payload).toContain('"city":"Z"');
  });
});

describe('a failed form and the session store', () => {
  it('stores no more than 64 KiB of errors and 64 KiB of input for a request with a 30,000-item list', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const store = wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) });
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
      modules: [defineModule({ name: 'forms', routes })],
    }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent' }, override: (container) => void container.instance(SessionStore, store) });
    const kernel = createHttpKernel(application);

    const response = await kernel.request('/tags', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html', 'content-type': 'application/json' },
      body: JSON.stringify({ tags: Array.from({ length: 30_000 }, (_, index) => index) }),
    });
    expect(response.status).toBe(303);
    expect(written).toHaveLength(1);
    const payload = written[0]!;
    // Errors and input are each capped at 64 KiB; the whole session (both, plus its own fields) stays well under twice that.
    expect(payload.length).toBeLessThan(2 * MAX + 1024);
    expect(payload).toContain('Item 0 must be a string.');
    expect(payload).not.toContain('Item 29999');
  });
});
