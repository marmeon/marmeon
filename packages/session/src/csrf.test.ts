import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, signed, UrlSigner, ValidationError, verifyWebhook, view, Webhooks, type PageObject } from '@marmeon/http';
import { signWebhook } from '@marmeon/http/internal';
import { createHttpKernel } from '@marmeon/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionConfig } from './config.ts';
import { CsrfConfig, CsrfProtection, VerifyCsrfToken } from './csrf.ts';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

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

/** A guest's page whose request writes the session (its first data). */
class CountController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('visits' as never, 1 as never);
    return view('shop/Page', {});
  }
}

/** JSON that writes the session and hands out nothing: the XSRF-TOKEN cookie is the first to need the token. */
class RememberController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('visits' as never, 1 as never);
    return { ok: true };
  }
}

/** What the session of the last `/peek` held as its CSRF token once its page was made — `undefined`: none was drawn. */
const peeked: { token?: string | undefined; persists?: boolean } = {};

/** Looks at the session after the route's response is made — the page's props asked for the token by then. */
class Peek {
  readonly #session: Session;
  constructor(session: Session) {
    this.#session = session;
  }
  async handle(_ctx: unknown, next: () => Promise<Response>) {
    const response = await next();
    await response.clone().text();
    Object.assign(peeked, { token: this.#session.currentToken(), persists: this.#session.persists });
    return response;
  }
}

const routes = openRoutes((Route) => {
  Route.middleware(Peek).get('/peek', () => view('shop/Page', {}));
  // A page whose request writes the session (a guest's first data): kept — its page carries the token it makes now.
  Route.get('/count', CountController);
  Route.get('/remember', RememberController);
  Route.get('/form', FormController);
  Route.get('/status', () => ({ ok: true }));
  Route.get('/page', () => view('shop/Page', {}));
  Route.post('/fail', () => {
    throw new ValidationError({ email: ['Wrong.'] }, { email: 'ada@example.com' });
  });
  Route.post('/save', () => ({ saved: true }));
  Route.post('/login', LoginController);
  Route.post('/webhooks/stripe', () => ({ received: true }));
  Route.middleware(verifyWebhook('payments')).post('/signed', () => ({ received: true }));
  Route.post('/unsigned', () => ({ received: true }));
  Route.middleware(signed({ withoutCsrf: true })).post('/leave/:id', (ctx) => ({ left: ctx.params.id })).name('leave');
  Route.middleware(signed({ withoutCsrf: true })).get('/leave/:id', (ctx) => ({ page: ctx.params.id }));
  Route.middleware(signed({ withoutCsrf: true })).post('/also-leave/:id', () => ({ left: true })).name('alsoLeave');
  Route.middleware(signed({ withoutCsrf: true, forever: true })).post('/leave-for-good/:id', () => ({ left: true })).name('leaveForGood');
  Route.middleware(signed()).post('/confirm/:id', () => ({ confirmed: true })).name('confirm');
});

// Put together at run time: a literal that looks like a secret would block the push.
const WEBHOOK_SECRET = ['sk', 'w'.repeat(24)].join('_');

class DefineWebhooks {
  boot(app: { container: { make(key: typeof Webhooks): Webhooks } }) {
    app.container.make(Webhooks).define('payments', { scheme: 'stripe', secrets: WEBHOOK_SECRET });
  }
}

async function boot(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DefineWebhooks],
    modules: [defineModule({ name: 'shop', routes, csrfExcept: ['/webhooks/*'] })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env } });
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
  return { send, token, application };
}

const form = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) });

describe('CsrfProtection.disable()', () => {
  it.each<Record<string, string>>([{ NODE_ENV: 'production' }, {}])('throws in a protected environment %j and leaves the protection on', async (env) => {
    const { application, send } = await boot(env);
    expect(() => application.container.make(CsrfProtection).disable()).toThrow('createTestApp(app, { csrf: true })');
    await send('/form');
    expect((await send('/save', form({}))).status).toBe(419);
  });

  it.each(['test', 'development'])('turns the check off with NODE_ENV %s', async (value) => {
    const { application, send } = await boot({ NODE_ENV: value });
    application.container.make(CsrfProtection).disable();
    await send('/form');
    expect((await send('/save', form({}))).status).not.toBe(419);
  });
});

describe('CsrfProtection.except()', () => {
  it.each(['*', '/*', '/**', '/***', '/*/unsubscribe/*', '/**/x', '/a*', '*/tail', 'webhooks/*', '/*/*', '/*/unsubscribe', '**'])('refuses %j: it does not start with a fixed segment', (pattern) => {
    expect(() => new CsrfProtection().except(pattern)).toThrow(TypeError);
  });

  it.each(['/webhooks/*', '/webhooks/**', '/w/*/unsubscribe', '/de/unsubscribe/*', '/:locale/leave', '/go'])('takes %j', (pattern) => {
    expect(() => new CsrfProtection().except(pattern)).not.toThrow();
  });

  it('takes a path, a prefix and an empty pattern', () => {
    const protection = new CsrfProtection().except('/webhooks/*', '');
    expect(protection.skips('/webhooks/stripe')).toBe(true);
    expect(protection.skips('/save')).toBe(false);
  });

  it('lets * match within one segment: a slug pattern leaves the routes below other slugs protected', () => {
    const protection = new CsrfProtection().except('/w/*/unsubscribe');
    expect(protection.skips('/w/a/unsubscribe')).toBe(true);
    expect(protection.skips('/w/a/b/unsubscribe')).toBe(false);
    expect(protection.skips('/x/a/unsubscribe')).toBe(false);
    expect(protection.skips('/w/a/unsubscribe/members')).toBe(false);
  });

  it('matches an empty segment and stops * at a slash, an encoded one included as part of the segment', () => {
    const protection = new CsrfProtection().except('/hooks/*');
    expect(protection.skips('/hooks/')).toBe(true);
    expect(protection.skips('/hooks/a')).toBe(true);
    expect(protection.skips('/hooks/a/b')).toBe(false);
    expect(protection.skips('/hooks/a/')).toBe(false);
    // The path arrives still encoded: `%2F` is not a separator the router would split at, and no `/` follows from it.
    expect(protection.skips('/hooks/a%2Fb')).toBe(true);
    expect(protection.skips('/hooks%2Fa')).toBe(false);
  });

  it('lets ** match across segments', () => {
    const protection = new CsrfProtection().except('/webhooks/**', '/a/**/z');
    expect(protection.skips('/webhooks/a')).toBe(true);
    expect(protection.skips('/webhooks/a/b/c')).toBe(true);
    expect(protection.skips('/webhooks')).toBe(false);
    expect(protection.skips('/other/webhooks/a')).toBe(false);
    expect(protection.skips('/a/b/c/z')).toBe(true);
    expect(protection.skips('/a/b/c/y')).toBe(false);
  });

  it('anchors at both ends, matches case-sensitively', () => {
    const protection = new CsrfProtection().except('/pay/*');
    expect(protection.skips('/x/pay/a')).toBe(false);
    expect(protection.skips('/pay/a/x')).toBe(false);
    expect(protection.skips('/Pay/a')).toBe(false);
  });

  it('takes every other character in a pattern literally', () => {
    const protection = new CsrfProtection().except('/v1.0/(a)+/[b]?/$c/^d|e/{f}/g\\h/*');
    expect(protection.skips('/v1.0/(a)+/[b]?/$c/^d|e/{f}/g\\h/x')).toBe(true);
    expect(protection.skips('/v1x0/(a)+/[b]?/$c/^d|e/{f}/g\\h/x')).toBe(false);
    expect(protection.skips('/v1.0/a/b/c/d/e/f/g/x')).toBe(false);
  });
});

describe('VerifyCsrfToken', () => {
  it('hands the browser a readable XSRF-TOKEN cookie (not HttpOnly, not encrypted)', async () => {
    const { send, token } = await boot();
    const response = await send('/form');
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith('XSRF-TOKEN='))!;
    expect(cookie).toMatch(/^XSRF-TOKEN=[\w-]{40}; Path=\/; SameSite=Lax$/);
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

  it('refuses a post with 419 when the session is of a newer format — its token counts for nothing, and nothing is written', async () => {
    const { send, token, application } = await boot();
    const store = application.container.make(SessionStore);
    const keys: string[] = [];
    const write = store.write.bind(store);
    store.write = (key, data, options) => (keys.push(key), write(key, data, options));
    await send('/count');
    const key = keys.at(-1)!;
    const handedOut = token();
    await store.destroy(key);
    await store.write(key, JSON.stringify({ _token: handedOut, _v: 3 }), { expectedVersion: undefined, lifetimeSeconds: 600 });
    const before = await store.read(key);
    const response = await send('/save', { method: 'POST', headers: { 'x-csrf-token': handedOut } });
    expect(response.status).toBe(419);
    expect(await store.read(key)).toEqual(before);
  });

  it('accepts the token as _token field, X-CSRF-TOKEN or X-XSRF-TOKEN header', async () => {
    const { send, token } = await boot();
    await send('/form');
    expect((await send('/save', form({ _token: token() }))).status).toBe(200);
    expect((await send('/save', { method: 'POST', headers: { 'x-csrf-token': token() } })).status).toBe(200);
    expect((await send('/save', { method: 'POST', headers: { 'x-xsrf-token': token() } })).status).toBe(200);
    expect((await send('/save', form({ _token: 'x'.repeat(40) }))).status).toBe(419);
  });

  it('never takes the token from the query string — it would end up in logs and Referers', async () => {
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

  describe('stage 1 — Fetch Metadata', () => {
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
      // No URL at all: the same line of the start error, never a crash of the start.
      await expect(boot({ CSRF_TRUSTED_ORIGINS: 'admin.example.com' })).rejects.toThrow(/csrf: CSRF_TRUSTED_ORIGINS — Expected an origin like https:\/\/admin\.example\.com/);
    });

    it('`Sec-Fetch-Site: none` (a navigation the user started — never a form) passes nothing by itself: Origin, then the token', async () => {
      const { send, token } = await boot();
      await send('/form');
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none' } })).status).toBe(419);
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none', origin: 'https://evil.example', 'x-xsrf-token': token() } })).status).toBe(403);
      expect((await send('/save', { method: 'POST', headers: { 'sec-fetch-site': 'none', 'x-xsrf-token': token() } })).status).toBe(200);
    });
  });

  describe('guests get no session for the token', () => {
    it('a page for a guest carries no token and sets no cookie — 100 times', async () => {
      const { send } = await boot();
      for (let i = 0; i < 100; i++) {
        const response = await send('/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(((await response.json()) as PageObject).csrf).toBeUndefined();
      }
    });

    it('a page for a guest draws no token at all — the session that is not kept never makes one', async () => {
      const { send } = await boot();
      const response = await send('/peek', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(peeked.persists).toBe(false);
      expect(peeked.token, 'a guest page drew a CSRF token').toBeUndefined();
      // Without one, a post that needs the token (no Fetch Metadata, no Origin) is still refused — the check is unchanged.
      expect((await send('/save', form({ _token: '' }))).status).toBe(419);
      expect((await send('/save', form({ _token: 'undefined' }))).status).toBe(419);
    });

    it('a page whose request keeps the session carries the token it makes — the same the XSRF-TOKEN cookie gets', async () => {
      const { send, token } = await boot();
      const response = await send('/count', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
      const page = (await response.json()) as PageObject;
      expect(page.csrf, 'the page of a kept session carries no token').toBeTypeOf('string');
      expect(page.csrf).toMatch(/^[\w-]{40}$/);
      expect(page.csrf).toBe(token());
      expect((await send('/save', form({ _token: page.csrf! }))).status).toBe(200);
    });

    it('a kept session whose request never asked for the token still gets it in its XSRF-TOKEN cookie — made then', async () => {
      const { send, token } = await boot();
      await send('/remember');
      expect(token(), 'the XSRF-TOKEN cookie of a kept session carries no token').toMatch(/^[\w-]{40}$/);
      expect((await send('/save', { method: 'POST', headers: { 'x-xsrf-token': token() } })).status).toBe(200);
    });

    it('sends XSRF-TOKEN only when the browser does not hold that value: not on the next request, again after a new token', async () => {
      const { send, token } = await boot();
      const names = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);
      expect(names(await send('/remember'))).toContain('XSRF-TOKEN');
      const held = token();
      const again = await send('/remember');
      expect(names(again)).not.toContain('XSRF-TOKEN');
      expect(names(again)).not.toContain('marmeon_session');
      const rotated = await send('/login', { method: 'POST', headers: { 'x-xsrf-token': held } });
      expect(names(rotated)).toContain('XSRF-TOKEN');
      expect(token()).not.toBe(held);
    });

    it('a failed guest form keeps its errors — that writes the session, and from then on its pages carry the token', async () => {
      const { send, token } = await boot();
      const failed = await send('/fail', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' } });
      expect(failed.status).toBe(303);
      expect(failed.headers.getSetCookie().map((cookie) => cookie.split('=')[0]).sort()).toEqual(['XSRF-TOKEN', 'marmeon_session']);
      const page = (await (await send('/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })).json()) as PageObject;
      expect(page.csrf).toBe(token());
      expect(page.props).toMatchObject({ errors: { email: ['Wrong.'] } });
    });
  });

  it('skips paths a module excepts, and reading requests', async () => {
    const { send } = await boot();
    expect((await send('/webhooks/stripe', form({}))).status).toBe(200);
    expect((await send('/form')).status).toBe(200);
  });

  it('judges the path alone: a query string holding a slash does not change a match', async () => {
    const { send } = await boot();
    expect((await send('/webhooks/stripe?next=/a/b', form({}))).status).toBe(200);
    expect((await send('/save?next=/webhooks/stripe', form({}))).status).toBe(419);
  });

  describe('a route behind verifyWebhook()', () => {
    const body = JSON.stringify({ type: 'invoice.paid' });
    const signedPost = (headers: Record<string, string> = {}, secret = WEBHOOK_SECRET) => ({
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...signWebhook('stripe', secret, body), ...headers },
    });

    it('needs no token, no session and no csrfExcept: the signature is its protection', async () => {
      const { send } = await boot();
      const response = await send('/signed', signedPost());
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('lets a sender through whatever its Origin and Fetch Metadata say — it is a server, not a browser', async () => {
      const { send } = await boot();
      expect((await send('/signed', signedPost({ origin: 'https://payments.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(200);
      expect((await send('/signed', signedPost({ origin: 'null' }))).status).toBe(200);
    });

    it('answers a wrong or missing signature with 401 — never with the token check\'s 419, and never with the route', async () => {
      const { send } = await boot();
      const forged = await send('/signed', signedPost({}, ['sk', 'q'.repeat(24)].join('_')));
      expect(forged.status).toBe(401);
      expect(await forged.json()).toEqual({ error: 'webhook_signature_invalid' });
      expect((await send('/signed', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    });

    it('does not open the routes beside it: a post without the middleware stays refused', async () => {
      const { send } = await boot();
      const attempt = { ...signedPost(), headers: { 'content-type': 'application/json', ...signWebhook('stripe', WEBHOOK_SECRET, body) } };
      expect((await send('/unsigned', attempt)).status).toBe(419);
      expect((await send('/unsigned', { ...attempt, headers: { ...attempt.headers, origin: 'https://evil.example' } })).status).toBe(403);
      expect((await send('/save', attempt)).status).toBe(419);
    });
  });

  describe('a route behind signed({ withoutCsrf: true })', () => {
    afterEach(() => vi.useRealTimers());
    const post = (extra: Record<string, string> = {}) => ({ method: 'POST', body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }), headers: extra });

    it('takes a post with a valid signature and no token, no session, no Origin', async () => {
      const { send, application } = await boot();
      const url = application.container.make(UrlSigner).signedRoute('leave', { id: 7 }, { expiresIn: { days: 1 } });
      const response = await send(url, post());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ left: '7' });
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('lets it through whatever its Origin and Fetch Metadata say: the link is the proof', async () => {
      const { send, application } = await boot();
      const url = application.container.make(UrlSigner).signedRoute('leave', { id: 7 }, { expiresIn: { days: 1 } });
      expect((await send(url, post({ origin: 'https://mail.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(200);
    });

    it('takes a forever link on a route that says forever, and refuses it on one that does not', async () => {
      const { send, application } = await boot();
      const signer = application.container.make(UrlSigner);
      expect((await send(signer.foreverSignedRoute('leaveForGood', { id: 7 }), post())).status).toBe(200);
      expect((await send(signer.foreverSignedRoute('leave', { id: 7 }), post())).status).toBe(419);
    });

    it('answers a missing, wrong or expired signature with the CSRF check: 419, or 403 from a foreign Origin', async () => {
      const { send, application } = await boot();
      const signer = application.container.make(UrlSigner);
      const url = signer.signedRoute('leave', { id: 7 }, { expiresIn: { days: 1 } });
      expect((await send('/leave/7', post())).status).toBe(419);
      expect((await send(url.replace(/signature=./, (m) => `signature=${m.endsWith('0') ? '1' : '0'}`), post())).status).toBe(419);
      expect((await send(`${url}0`, post())).status).toBe(419);
      expect((await send('/leave/7', post({ origin: 'https://evil.example' }))).status).toBe(403);
      const short = signer.signedRoute('leave', { id: 7 }, { expiresIn: 60 });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 120_000);
      expect((await send(short, post())).status).toBe(419);
    });

    it('is not opened by a link of another route or with other parameters', async () => {
      const { send, application } = await boot();
      const signer = application.container.make(UrlSigner);
      const other = signer.signedRoute('alsoLeave', { id: 7 }, { expiresIn: { days: 1 } });
      const url = new URL(signer.signedRoute('leave', { id: 7 }, { expiresIn: { days: 1 } }), 'http://x');
      // Another route's query on this route, this route's query on another id, another param added.
      expect((await send(`/leave/7?${new URL(other, 'http://x').searchParams}`, post())).status).toBe(419);
      expect((await send(`/leave/8${url.search}`, post())).status).toBe(419);
      expect((await send(`${url.pathname}${url.search}&list=news`, post())).status).toBe(419);
    });

    it('does not open a route beside it: without withoutCsrf a valid signature still needs the token', async () => {
      const { send, application } = await boot();
      const url = application.container.make(UrlSigner).signedRoute('confirm', { id: 7 }, { expiresIn: { days: 1 } });
      expect((await send(url, post())).status).toBe(419);
      expect((await send(url, post({ origin: 'https://evil.example' }))).status).toBe(403);
    });

    it('reads as before: a GET passes with and without a signature (signed() answers 403 to the latter)', async () => {
      const { send, application } = await boot();
      const url = application.container.make(UrlSigner).signedRoute('leave', { id: 7 }, { expiresIn: { days: 1 } });
      expect((await send(url)).status).toBe(200);
      expect((await send('/leave/7')).status).toBe(403);
      expect((await send(url, { method: 'HEAD' })).status).toBe(200);
    });
  });

  it('stops the start of an app whose route names a webhook nobody defined', async () => {
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
      modules: [defineModule({ name: 'shop', routes: openRoutes((Route) => Route.middleware(verifyWebhook('missing')).post('/hook', () => ({ ok: true }))) })],
    }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' } });
    expect(() => createHttpKernel(application)).toThrow(/\[marmeon:H12\] Webhook \[missing\] is not defined, but POST \/hook uses verifyWebhook\('missing'\)/);
  });

  it('refuses a post with 419 when the context has no route (a global dispatch)', async () => {
    const { application } = await boot();
    const check = new VerifyCsrfToken(
      { currentToken: () => undefined, readOnly: true, persists: false } as never,
      new CsrfProtection(),
      application.container.make(CsrfConfig),
      application.container.make(SessionConfig),
      application.container.make(UrlSigner),
    );
    const request = new Request('http://app.test/x', { method: 'POST' });
    const ctx = { request, input: async () => ({}) } as never;
    await expect(check.handle(ctx, (async () => new Response()) as never)).rejects.toMatchObject({ status: 419 });
  });
});
