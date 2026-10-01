import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';

class LoginController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.regenerate(); // rotates the CSRF token too
    return { ok: true };
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/form', () => ({ ok: true }));
  Route.post('/save', () => ({ saved: true }));
  Route.post('/login', LoginController);
  Route.post('/webhooks/stripe', () => ({ received: true }));
});

async function boot(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    modules: [defineModule({ name: 'shop', routes, csrfExcept: ['/webhooks/*'] })],
  });
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  /** A browser: keeps cookies, sends JSON-accepting requests. */
  const send = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: RequestInit['body'] } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { ...init, headers: { accept: 'application/json', cookie, ...init.headers } });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      jar.set(name, value);
    }
    return response;
  };
  const token = () => decodeURIComponent(jar.get('XSRF-TOKEN') ?? '');
  return { send, token };
}

const form = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) });

describe('VerifyCsrfToken', () => {
  it('hands the browser a readable XSRF-TOKEN cookie (not HttpOnly, not encrypted)', async () => {
    const { send, token } = await boot();
    const response = await send('/form');
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith('XSRF-TOKEN='))!;
    expect(cookie).toMatch(/^XSRF-TOKEN=[\w-]{40}; Path=\/; Max-Age=7200; SameSite=Lax$/);
    expect(token()).toMatch(/^[\w-]{40}$/);
  });

  it('refuses a post without token with 419', async () => {
    const { send } = await boot();
    await send('/form');
    const response = await send('/save', form({}));
    expect(response.status).toBe(419);
    expect(await response.json()).toEqual({ message: 'CSRF token mismatch.' });
  });

  it('accepts the token as _token field, X-CSRF-TOKEN or X-XSRF-TOKEN header', async () => {
    const { send, token } = await boot();
    await send('/form');
    expect((await send('/save', form({ _token: token() }))).status).toBe(200);
    expect((await send('/save', { method: 'POST', headers: { 'x-csrf-token': token() } })).status).toBe(200);
    expect((await send('/save', { method: 'POST', headers: { 'x-xsrf-token': token() } })).status).toBe(200);
    expect((await send('/save', form({ _token: 'x'.repeat(40) }))).status).toBe(419);
  });

  it('never takes the token from the query string — it would end up in logs and Referers (E65)', async () => {
    const { send, token } = await boot();
    await send('/form');
    expect((await send(`/save?_token=${token()}`, form({}))).status).toBe(419);
  });

  it('rotates the token with the session id — the old one stops working', async () => {
    const { send, token } = await boot();
    await send('/form');
    const before = token();
    await send('/login', form({ _token: before }));
    expect(token()).not.toBe(before);
    expect((await send('/save', form({ _token: before }))).status).toBe(419);
    expect((await send('/save', form({ _token: token() }))).status).toBe(200);
  });

  it('refuses cross-site requests even with a valid token (Fetch Metadata, Origin)', async () => {
    const { send, token } = await boot({ CSRF_TRUSTED_ORIGINS: 'https://admin.example.com' });
    await send('/form');
    const post = (headers: Record<string, string>) => send('/save', { method: 'POST', headers: { 'x-xsrf-token': token(), ...headers } });

    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(419);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(419);
    expect((await post({ origin: 'null' })).status).toBe(419);
    expect((await post({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost' })).status).toBe(200);
    expect((await post({ origin: 'https://admin.example.com' })).status).toBe(200);
    expect((await post({})).status).toBe(200); // no metadata at all (curl, old clients): the token decides
  });

  it('skips paths a module excepts, and reading requests', async () => {
    const { send } = await boot();
    expect((await send('/webhooks/stripe', form({}))).status).toBe(200);
    expect((await send('/form')).status).toBe(200);
  });
});
