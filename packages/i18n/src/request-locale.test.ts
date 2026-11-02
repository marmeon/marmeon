import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, island, view, type HttpContext } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { defineRequest, defineRoutes, everyone, type RouteBinder } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { Session, SessionServiceProvider } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { describe, expect, it } from 'vitest';
import { I18nServiceProvider, Locales, RequestLocale, Translator } from './index.ts';
import { CurrentLocale } from './translator.ts';

const root = join(import.meta.dirname, '__fixtures__', 'shop');

interface Event {
  id: string;
  locale: string | null;
}

const events: Record<string, Event> = {
  german: { id: 'german', locale: 'de' },
  english: { id: 'english', locale: 'en' },
  french: { id: 'french', locale: 'fr' },
  none: { id: 'none', locale: null },
  secret: { id: 'secret', locale: 'de' },
};

class Events implements RouteBinder<Event> {
  resolveRouteBinding(value: string) {
    return events[value];
  }
}

class ShowEventController extends Controller {
  readonly #translator: Translator;
  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }
  handle(ctx: HttpContext<{}, { event: Event }>) {
    return view('shop/About', { greeting: this.#translator.get('shop.greeting', { name: ctx.params.event.id }) });
  }
}

class RegisterController extends Controller {
  static request = defineRequest({ schema: r.object({ name: r.string().required() }) });
  handle() {
    return { ok: true };
  }
}

/** What the hook of `/events/:event/…` saw, per request: its greeting and whether it could write the session. */
const hooked: { greeting?: string; readOnly?: boolean } = {};

const routes = defineRoutes((Root) => {
  const open = Root.authorize(everyone);
  const event = open
    .bind('event', Events)
    .authorize((ctx: HttpContext<{}, { event: Event }>) => ctx.params.event.id !== 'secret')
    .afterAuthorize((ctx, resolve) => {
      resolve(RequestLocale).use(ctx.params.event.locale);
    });
  event.get('/events/:event', ShowEventController).name('events.show');
  event.post('/events/:event/register', RegisterController).name('events.register');
  // A hook that translates through `resolve(Translator)` and writes the session only when the request may.
  const noted = open.bind('event', Events, { public: true }).afterAuthorize((ctx, resolve) => {
    resolve(RequestLocale).use(ctx.params.event.locale);
    hooked.greeting = resolve(Translator).get('shop.greeting', { name: ctx.params.event.id });
    const session = resolve(Session);
    hooked.readOnly = session.readOnly;
    if (!session.readOnly) session.put('last_event', ctx.params.event.id);
  });
  noted.get('/notes/:event', ShowEventController).name('notes.show');
  noted.get('/notes/:event/panel', () => island('shop/Panel', {})).name('notes.panel');
  open.localized().bind('event', Events, { public: true }).afterAuthorize((ctx, resolve) => {
      resolve(RequestLocale).use(ctx.params.event.locale);
    }).get('/guide/:event', ShowEventController).name('events.guide');
});

async function boot() {
  const application = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider],
    modules: [defineModule({ name: 'shop', routes, csrfExcept: ['/events/*/register'] })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_LOCALES: 'en,de' } });
  return createHttpKernel(application);
}

const visit = { [PAGE_HEADER]: PROTOCOL_VERSION };
const json = { accept: 'application/json', 'content-type': 'application/json' };

describe('RequestLocale', () => {
  it('speaks the language of the record: the page, <html lang> and Content-Language, against the browser’s language', async () => {
    const kernel = await boot();
    const page = await kernel.request('/events/german', { headers: { ...visit, 'accept-language': 'en' } });
    expect(await page.json()).toMatchObject({ locale: 'de', props: { greeting: 'Hallo german' } });
    expect(page.headers.get('content-language')).toBe('de');
    expect(await (await kernel.request('/events/german', { headers: { accept: 'text/html', 'accept-language': 'en' } })).text()).toContain('<html lang="de">');
    const english = await kernel.request('/events/english', { headers: { ...visit, 'accept-language': 'de' } });
    expect(await english.json()).toMatchObject({ locale: 'en', props: { greeting: 'Hello english' } });
    expect(english.headers.get('content-language')).toBe('en');
  });

  it('writes the messages of a failed form in the language of the record', async () => {
    const kernel = await boot();
    const german = await kernel.request('/events/german/register', { method: 'POST', headers: { ...json, 'accept-language': 'en' }, body: '{}' });
    expect(german.status).toBe(422);
    expect(german.headers.get('content-language')).toBe('de');
    expect(await german.text()).toContain('erforderlich');
    const english = await kernel.request('/events/english/register', { method: 'POST', headers: { ...json, 'accept-language': 'de' }, body: '{}' });
    expect(english.status).toBe(422);
    expect(await english.text()).toContain('required');
  });

  it('translates in the language of the record from a hook with resolve(Translator), and tells a hook whether the session may change', async () => {
    const kernel = await boot();
    const page = await kernel.request('/notes/german', { headers: { ...visit, 'accept-language': 'en' } });
    expect(page.status).toBe(200);
    expect(hooked).toEqual({ greeting: 'Hallo german', readOnly: false });
    // The island of that page runs the same hook with a read-only session: the hook skips its write and the island answers.
    const panel = await kernel.request('/notes/english/panel', { headers: { ...visit, 'x-marmeon-region': 'island', 'accept-language': 'de' } });
    expect(panel.status).toBe(200);
    expect(hooked).toEqual({ greeting: 'Hello english', readOnly: true });
  });

  it('keeps the visitor’s locale when the record’s is not supported or missing', async () => {
    const kernel = await boot();
    for (const id of ['french', 'none']) {
      const response = await kernel.request(`/events/${id}`, { headers: { ...visit, 'accept-language': 'de' } });
      expect(await response.json()).toMatchObject({ locale: 'de' });
      expect(response.headers.get('content-language')).toBe('de');
    }
  });

  it('answers a refused request in the language that held before: nothing of the record leaks', async () => {
    const kernel = await boot();
    const refused = await kernel.request('/events/secret', { headers: { accept: 'text/html', 'accept-language': 'en' } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('content-language')).toBe('en');
    expect(await refused.text()).toContain('<html lang="en">');
    const missing = await kernel.request('/events/nobody', { headers: { accept: 'text/html', 'accept-language': 'en' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-language')).toBe('en');
  });

  it('throws on a localized route, where the URL names the locale', async () => {
    const kernel = await boot();
    const response = await kernel.request('/de/guide/english', { headers: visit });
    expect(response.status).toBe(500);
  });

  it('names the cause: use() on a localized request throws its own error', () => {
    const current = new CurrentLocale('en');
    current.localized = true;
    expect(() => new RequestLocale(current, new Locales({ locale: 'en', fallback: 'en', locales: ['en', 'de'] } as never)).use('de')).toThrow('RequestLocale.use(): this route is localized');
    expect(current.value).toBe('en');
  });

  it('is typed: a locale is a string, null or undefined, and use() tells whether it applied', () => {
    const apply = (requestLocale: RequestLocale): boolean => requestLocale.use(null);
    // @ts-expect-error a number is no locale
    const wrong = (requestLocale: RequestLocale) => requestLocale.use(5);
    expect(apply).toBeTypeOf('function');
    expect(wrong).toBeTypeOf('function');
  });
});
