import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider, ValidationError, view, type PageObject } from '@bespokecore/http';
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

/** A form: it hands out the token (a page does, for its forms) — the session is kept. */
class FormController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return { _token: this.#session.token() };
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/form', FormController);
  Route.get('/status', () => ({ ok: true }));
  Route.get('/page', () => view('shop/Page', {}));
  Route.post('/fail', () => {
    throw new ValidationError({ email: ['Wrong.'] }, { email: 'ada@example.com' });
  });
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

  it('hands out no token — and keeps no session — for a response that never uses it (a health check, a bot)', async () => {
    const { send } = await boot();
    const response = await send('/status');
    expect(response.headers.getSetCookie()).toEqual([]);
    // A post without any session is refused — and leaves none behind either.
    const refused = await send('/save', form({ _token: 'x'.repeat(40) }));
    expect(refused.status).toBe(419);
    expect(refused.headers.getSetCookie()).toEqual([]);
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

  it('stage 3 — neither Fetch Metadata nor Origin (curl, older clients): the session token decides, 419 without it', async () => {
    const { send, token } = await boot();
    await send('/form');
    expect((await send('/save', { method: 'POST' })).status).toBe(419);
    expect((await send('/save', { method: 'POST', headers: { 'x-xsrf-token': token() } })).status).toBe(200);
  });

  describe('stage 1 — Fetch Metadata (E143)', () => {
    it('lets a same-origin request through without a token — and without a session (a guest signing in)', async () => {
      const { send } = await boot();
      const response = await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]); // nothing written: no session, no XSRF-TOKEN
    });

    it('refuses a cross-site request with 403 — even with a valid token, and without any Origin to fall back on', async () => {
      const { send, token } = await boot();
      await send('/form');
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      const refused = await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'x-xsrf-token': token() } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ message: 'Cross-site request refused.' });
    });

    it('refuses a same-site request (a subdomain) unless its origin is trusted — then without a token', async () => {
      const { send } = await boot({ CSRF_TRUSTED_ORIGINS: 'https://admin.example.com, https://partner.example' });
      const post = (headers: Record<string, string>) => send('/save', { method: 'POST', headers });
      expect((await post({ 'sec-fetch-site': 'same-site', origin: 'https://blog.example.com' })).status).toBe(403);
      expect((await post({ 'sec-fetch-site': 'same-site', origin: 'http://admin.example.com' })).status).toBe(403); // the scheme counts
      expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await post({ 'sec-fetch-site': 'same-site', origin: 'https://admin.example.com' })).status).toBe(200);
      expect((await post({ 'sec-fetch-site': 'cross-site', origin: 'https://partner.example' })).status).toBe(200);
    });
  });

  describe('stage 2 — Origin, when the browser sends no Fetch Metadata (plain HTTP, older browsers)', () => {
    it('lets the app\'s own origin through without a token — the one it is reached at, or APP_URL\'s', async () => {
      const { send } = await boot({ APP_URL: 'https://shop.example' });
      expect((await send('/save', { method: 'POST', headers: { origin: 'http://localhost' } })).status).toBe(200);
      expect((await send('/save', { method: 'POST', headers: { origin: 'https://shop.example' } })).status).toBe(200);
      expect((await send('/save', { method: 'POST', headers: { origin: 'http://localhost:8080' } })).status).toBe(403); // another port
    });

    it('refuses a foreign origin with 403 — even with a valid token; `null` (a sandboxed frame) counts as foreign', async () => {
      const { send, token } = await boot();
      await send('/form');
      const post = (origin: string) => send('/save', { method: 'POST', headers: { origin, 'x-xsrf-token': token() } });
      expect((await post('https://evil.example')).status).toBe(403);
      expect((await post('null')).status).toBe(403);
      expect((await post('not a url')).status).toBe(403);
    });

    it('takes trusted origins (CSRF_TRUSTED_ORIGINS) — and rejects one with a path at boot', async () => {
      const { send } = await boot({ CSRF_TRUSTED_ORIGINS: 'https://admin.example.com' });
      expect((await send('/save', { method: 'POST', headers: { origin: 'https://admin.example.com' } })).status).toBe(200);
      await expect(boot({ CSRF_TRUSTED_ORIGINS: 'https://admin.example.com/panel' })).rejects.toThrow(/Expected an origin like https:\/\/admin\.example\.com/);
    });

    it('`Sec-Fetch-Site: none` (a navigation the user started — never a form) passes nothing by itself: Origin, then the token', async () => {
      const { send, token } = await boot();
      await send('/form');
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none' } })).status).toBe(419);
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none', origin: 'https://evil.example', 'x-xsrf-token': token() } })).status).toBe(403);
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none', 'x-xsrf-token': token() } })).status).toBe(200);
    });
  });

  describe('guests get no session for the token (E143)', () => {
    it('a page for a guest carries no token and sets no cookie — 100 times', async () => {
      const { send } = await boot();
      for (let i = 0; i < 100; i++) {
        const response = await send('/page', { headers: { 'x-bespoke': 'true' } });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(((await response.json()) as PageObject).csrf).toBeUndefined();
      }
    });

    it('a failed guest form keeps its errors — that writes the session, and from then on its pages carry the token', async () => {
      const { send, token } = await boot();
      const failed = await send('/fail', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' } });
      expect(failed.status).toBe(303);
      expect(failed.headers.getSetCookie().map((cookie) => cookie.split('=')[0]).sort()).toEqual(['XSRF-TOKEN', 'bespoke_session']);
      const page = (await (await send('/page', { headers: { 'x-bespoke': 'true' } })).json()) as PageObject;
      expect(page.csrf).toBe(token());
      expect(page.props).toMatchObject({ errors: { email: ['Wrong.'] } });
    });
  });

  it('skips paths a module excepts, and reading requests', async () => {
    const { send } = await boot();
    expect((await send('/webhooks/stripe', form({}))).status).toBe(200);
    expect((await send('/form')).status).toBe(200);
  });
});
