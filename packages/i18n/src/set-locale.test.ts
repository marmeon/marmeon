import { join } from 'node:path';
import { createApplication, defineModule, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, view, type HttpContext } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { defineRoutes, everyone, GLOBAL, Router } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { Session, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { I18nServiceProvider, LocalePreference, SetLocale, Translator } from './index.ts';

const root = join(import.meta.dirname, '__fixtures__', 'shop');

class AboutController extends Controller {
  readonly #translator: Translator;
  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }
  handle() {
    return view('shop/About', { greeting: this.#translator.get('shop.greeting', { name: 'Ada' }) });
  }
}

class SessionLocaleController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle(ctx: HttpContext<{}, { locale: string }>) {
    this.#session.put('locale', ctx.params.locale);
    return { ok: true };
  }
}

class StoredLocaleController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return { locale: this.#session.get('locale') ?? null };
  }
}

class GoController extends Controller {
  handle() {
    return this.redirect().route('about.feature', { feature: 'x y' });
  }
}

/** From a localized page: the redirect leads to the page's own locale (the URL's), not the visitor's preferred one. */
class GoFromPageController extends Controller {
  handle() {
    return this.redirect().route('about');
  }
}

const routes = defineRoutes((Root) => {
  const open = Root.authorize(everyone);
  const localized = open.localized();
  localized.get('/about', AboutController).name('about');
  localized.get('/about/features/:feature', AboutController).name('about.feature');
  open.get('/about-plain', AboutController).name('about-plain');
  open.get('/session/:locale', SessionLocaleController);
  open.get('/session', StoredLocaleController);
  open.post('/go', GoController).name('go');
  localized.post('/leave', GoFromPageController);
});

/** Localized pages in a group of their own, without a session — what a CDN-friendly group of an app looks like. */
const PUBLIC = 'public';
class PublicProvider implements ServiceProvider {
  register(container: Container): void {
    container.make(Router).load({ group: PUBLIC }, defineRoutes((Root) => Root.authorize(everyone).localized().get('/guide', AboutController).name('guide')));
  }
  boot(app: Application): void {
    app.container.make(Router).middleware.append(PUBLIC, SetLocale);
  }
}

async function boot({ env = {}, override }: { env?: Record<string, string>; override?: (container: Container) => void } = {}) {
  const application = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider, PublicProvider],
    modules: [defineModule({ name: 'shop', routes, csrfExcept: ['/go', '/:locale/leave'] })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_LOCALES: 'en,de', ...env }, override });
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  /** A browser: keeps its cookies. */
  const send = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { ...init, headers: { cookie, ...init.headers } });
    for (const header of response.headers.getSetCookie()) {
      const [name, value] = header.split(';')[0]!.split('=') as [string, string];
      jar.set(name, value);
    }
    return response;
  };
  return { application, send };
}

const visit = { [PAGE_HEADER]: PROTOCOL_VERSION };
const pageOf = async (response: Response) =>
  (await response.json()) as { component: string; props: Record<string, any>; locale?: string; epoch?: string; alternates?: Record<string, string> };

describe('SetLocale on a localized route', () => {
  it('speaks the locale of the URL, whatever the session and the browser say — and keeps no Vary: accept-language', async () => {
    const { send } = await boot();
    await send('/session/en');
    const german = await send('/de/about', { headers: { ...visit, 'accept-language': 'en' } });
    expect(await pageOf(german)).toMatchObject({ locale: 'de', props: { greeting: 'Hallo Ada' } });
    expect(german.headers.get('content-language')).toBe('de');
    expect(german.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    const english = await send('/en/about', { headers: { ...visit, 'accept-language': 'de' } });
    expect(await pageOf(english)).toMatchObject({ locale: 'en', props: { greeting: 'Hello Ada' } });
    expect(english.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
  });

  it('sets <html lang> from the URL', async () => {
    const { send } = await boot();
    expect(await (await send('/de/about', { headers: { accept: 'text/html', 'accept-language': 'en' } })).text()).toContain('<html lang="de">');
  });

  it('never writes the session: a link cannot change the visitor’s stored choice', async () => {
    const { send } = await boot();
    await send('/session/en');
    await send('/de/about', { headers: visit });
    expect(await (await send('/session')).json()).toEqual({ locale: 'en' });

    const fresh = await boot();
    await fresh.send('/de/about', { headers: visit });
    await fresh.send('/en/about/features/x', { headers: visit });
    expect(await (await fresh.send('/session')).json()).toEqual({ locale: null });
  });

  it('leaves a route that is not localized as it was: the visitor’s choice, and Vary: accept-language', async () => {
    const { send } = await boot();
    const response = await send('/about-plain', { headers: { ...visit, 'accept-language': 'de' } });
    expect(await pageOf(response)).toMatchObject({ locale: 'de' });
    expect(response.headers.get('vary')).toMatch(/accept-language/);
    expect(response.headers.get('content-language')).toBe('de');
    expect(await pageOf(await send('/about-plain', { headers: visit }))).toMatchObject({ locale: 'en' });
    expect('alternates' in (await pageOf(await send('/about-plain', { headers: visit })))).toBe(false);
  });

  it('answers a locale that is not supported with a 404, not with the default', async () => {
    const { send } = await boot();
    expect((await send('/fr/about', { headers: visit })).status).toBe(404);
    expect((await send('/DE/about', { headers: visit })).status).toBe(404);
  });

  it('runs in a group without a session: no error, no cookie, the URL decides', async () => {
    const { send } = await boot();
    const german = await send('/de/guide', { headers: { ...visit, 'accept-language': 'en' } });
    expect(german.status).toBe(200);
    expect(await pageOf(german)).toMatchObject({ locale: 'de', props: { greeting: 'Hallo Ada' } });
    expect(german.headers.getSetCookie()).toEqual([]);
    expect(german.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    expect((await pageOf(await send('/en/guide', { headers: visit }))).locale).toBe('en');
    // The URL without its locale: the redirect runs there too, and chooses by the browser.
    const bare = await send('/guide', { headers: { 'accept-language': 'de' } });
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toBe('/de/guide');
    expect(bare.headers.getSetCookie()).toEqual([]);
  });

  it('puts the page in every locale into page.alternates — the query kept, x-default without a locale', async () => {
    const { send } = await boot();
    const page = await pageOf(await send('/de/about/features/a%20b?tab=1&x=%2F%2Fevil.example', { headers: visit }));
    expect(page.alternates).toEqual({
      en: '/en/about/features/a%20b?tab=1&x=%2F%2Fevil.example',
      de: '/de/about/features/a%20b?tab=1&x=%2F%2Fevil.example',
      'x-default': '/about/features/a%20b?tab=1&x=%2F%2Fevil.example',
    });
    expect((await pageOf(await send('/en/about', { headers: visit }))).alternates).toEqual({ en: '/en/about', de: '/de/about', 'x-default': '/about' });
  });

  it('builds the alternates from the route, never from the request’s path: an encoded slash stays one parameter', async () => {
    const { send } = await boot();
    const page = await pageOf(await send('/de/about/features/%2F%2Fevil.example', { headers: visit }));
    expect(page.alternates?.['x-default']).toBe('/about/features/%2F%2Fevil.example');
    for (const path of Object.values(page.alternates ?? {})) expect(path).toMatch(/^\/(?!\/)/);
  });

  it('answers a dot segment in the URL with a 404 — never a 500, never alternates', async () => {
    const { send } = await boot();
    for (const path of ['/de/about/features/%2E%2E', '/de/about/features/%2e']) expect((await send(path, { headers: visit })).status).toBe(404);
  });

  it('sends the visitor, redirecting to a localized route without a locale, to the request’s', async () => {
    const { send } = await boot();
    const response = await send('/go', { method: 'POST', headers: { 'accept-language': 'de' } });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/de/about/features/x%20y');
  });

  it('takes the locale of the page it leaves, not the visitor’s preferred one', async () => {
    const { send } = await boot();
    const response = await send('/de/leave', { method: 'POST', headers: { 'accept-language': 'en', 'sec-fetch-site': 'same-origin' } });
    expect(response.headers.get('location')).toBe('/de/about');
  });

  it('keeps the locale of the redirect’s URL when its target is localized and names one', async () => {
    const { send } = await boot();
    const response = await send('/go', { method: 'POST', headers: { 'accept-language': 'en' } });
    expect(response.headers.get('location')).toBe('/en/about/features/x%20y');
  });
});

describe('the epoch follows the visitor’s preferred locale, not the URL', () => {
  it('is the same on /de/… and /en/… of one session, and changes with the session’s locale', async () => {
    const { send } = await boot();
    const epoch = async (path: string) => (await pageOf(await send(path, { headers: visit }))).epoch;
    const german = await epoch('/de/about');
    expect(german).toBeTypeOf('string');
    expect(await epoch('/en/about')).toBe(german);
    expect(await epoch('/de/about/features/x')).toBe(german);
    await send('/session/de');
    const chosen = await epoch('/en/about');
    expect(chosen).not.toBe(german);
    expect(await epoch('/de/about')).toBe(chosen);
  });

  it('is the one a page that is not localized gets for the same preference', async () => {
    const { send } = await boot();
    await send('/session/de');
    expect((await pageOf(await send('/en/about', { headers: visit }))).epoch).toBe((await pageOf(await send('/about-plain', { headers: visit }))).epoch);
  });

  it('is none for a localized page without a session: it depends on neither the URL nor the browser’s languages', async () => {
    const { send } = await boot();
    for (const path of ['/de/guide', '/en/guide']) {
      for (const language of ['en', 'de', undefined]) {
        const page = await pageOf(await send(path, { headers: { ...visit, ...(language ? { 'accept-language': language } : {}) } }));
        expect(page.locale, path).toBe(path.slice(1, 3));
        expect(page.epoch, `${path} ${language}`).toBeUndefined();
      }
    }
  });
});

describe('UrlLocales.preferred — where the URL without a locale leads', () => {
  const to = async (send: Awaited<ReturnType<typeof boot>>['send'], headers: Record<string, string> = {}) => (await send('/about', { headers })).headers.get('location');

  it('follows the session, then the account, then the browser, then APP_LOCALE', async () => {
    let account: string | undefined;
    const { send } = await boot({ env: { APP_LOCALE: 'en' }, override: (c) => c.scoped(LocalePreference, () => ({ preferredLocale: async () => account })) });
    expect(await to(send)).toBe('/en/about'); // nobody names one: APP_LOCALE
    expect(await to(send, { 'accept-language': 'de' })).toBe('/de/about'); // the browser
    account = 'en';
    expect(await to(send, { 'accept-language': 'de' })).toBe('/en/about'); // the account beats the browser
    await send('/session/de');
    expect(await to(send, { 'accept-language': 'en' })).toBe('/de/about'); // the session beats the account
    account = 'xx';
    expect(await to(send)).toBe('/de/about');
  });

  it('never leads to a locale the app does not support, whatever the header says', async () => {
    const { send } = await boot();
    for (const header of ['fr', '../../evil', '//evil.example', 'de"><script>']) {
      const location = await to(send, { 'accept-language': header });
      expect(location, header).toBe('/en/about');
    }
  });

  it('sends the redirect to no shared cache', async () => {
    const { send } = await boot();
    const response = await send('/about?x=1', { headers: { 'accept-language': 'de' } });
    expect(response.headers.get('location')).toBe('/de/about?x=1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toMatch(/accept-language.*cookie|cookie.*accept-language/);
  });
});

describe('SetLocale as global middleware', () => {
  it('answers a path that matches no route with a 404, not an error: there is no route to be localized', async () => {
    const { send } = await boot({
      override: (container) => container.make(Router).middleware.append(GLOBAL, SetLocale),
    });
    expect((await send('/nothing-here', { headers: visit })).status).toBe(404);
  });
});
