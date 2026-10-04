import { join } from 'node:path';
import { ConfigError, createApplication, defineModule, type Container } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import type { StandardOptions } from '@bespokecore/router';
import { abort, Controller, defineRequest, defineRoutes, HttpServiceProvider, PAGE_HEADER, view, type ContextOf, type HttpContext } from '@bespokecore/http';
import { createHttpKernel } from '@bespokecore/server';
import { password } from '@bespokecore/auth';
import { Session, SessionServiceProvider } from '@bespokecore/session';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { Catalog, CurrentLocale, I18nServiceProvider, LocalePreference, Locales, trans, Translator, Translators } from './index.ts';
import { createTranslator } from './translator.ts';

// Counts the translators made (W8 step 9: only for a request that asks for one).
vi.mock('./translator.ts', async (original) => {
  const actual = await original<typeof import('./translator.ts')>();
  return { ...actual, createTranslator: vi.fn(actual.createTranslator) };
});

const root = join(import.meta.dirname, '__fixtures__', 'shop');

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    shop: (typeof import('./__fixtures__/shop/modules/shop/lang/en.ts'))['default'];
    app: (typeof import('./__fixtures__/shop/lang/en.ts'))['default'];
  }
}

class HelloController extends Controller {
  readonly #translator: Translator;
  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }
  handle() {
    return view('shop/Hello', {
      greeting: this.#translator.get('shop.greeting', { name: 'Ada' }),
      cart: this.#translator.get('shop.cart', { count: 2 }),
      html: this.#translator.get('shop.html', { value: '<img src=x onerror=alert(1)>' }),
    });
  }
}

/** Waits for the test to let it go — between reading the locale (middleware) and translating (here). */
const gates = new Map<string, () => void>();
const arrived = new Map<string, () => void>();
class SlowController extends Controller {
  readonly #translator: Translator;
  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }
  async handle(ctx: HttpContext<{}, { id: string }>) {
    await new Promise<void>((resolve) => {
      gates.set(ctx.params.id, resolve);
      arrived.get(ctx.params.id)?.();
    });
    return { locale: this.#translator.locale, greeting: this.#translator.get('shop.greeting', { name: ctx.params.id }) };
  }
}

class ChooseLocaleController extends Controller {
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

const SignupRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(), v.minLength(3, trans('shop.validation.name_min'))),
    email: v.pipe(v.string(), v.email('shop.validation.email')),
    password: password(),
  }),
});

class SignupController extends Controller {
  static request = SignupRequest;
  handle(ctx: ContextOf<typeof SignupRequest>) {
    return { name: ctx.body.name };
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/hello', HelloController);
  Route.get('/slow/:id', SlowController);
  Route.get('/choose/:locale', ChooseLocaleController);
  Route.post('/signup', SignupController);
  Route.post('/form', () => ({ ok: true }));
  Route.get('/gone', () => abort(404));
});

async function boot({ env = {}, override }: { env?: Record<string, string>; override?: (container: Container) => void } = {}) {
  const application = await createApplication({
    root,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_LOCALES: 'en,de', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider],
    modules: [defineModule({ name: 'shop', routes, csrfExcept: ['/signup'] })],
    override,
  });
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  /** A browser: keeps its cookies. */
  const send = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: RequestInit['body'] } = {}) => {
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

const page = async (response: Response) => (await response.json()) as { component: string; props: Record<string, any>; locale?: string; fallbackLocale?: string };

describe('the request locale (SetLocale)', () => {
  it("speaks the browser's language — the page carries only the locale, the props are translated on the server", async () => {
    const { send } = await boot();
    const response = await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de-AT,de;q=0.9,en;q=0.5' } });
    expect(await page(response)).toMatchObject({ locale: 'de', props: { greeting: 'Hallo Ada', cart: '2 Artikel im Warenkorb' } });
    expect(response.headers.get('content-language')).toBe('de');
    expect(response.headers.get('vary')).toMatch(/accept-language/);

    const english = await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'fr, en;q=0.4' } }));
    expect(english).toMatchObject({ locale: 'en', props: { greeting: 'Hello Ada', cart: '2 items in your cart' } });
    // Nobody named one we have: APP_LOCALE.
    expect((await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'fr' } }))).locale).toBe('en');
  });

  it('the session wins over the user, the user over the browser', async () => {
    let preferred: string | undefined = 'de';
    const { send } = await boot({ override: (c) => c.scoped(LocalePreference, () => ({ preferredLocale: async () => preferred })) });
    const locale = async () => (await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'en' } }))).locale;
    expect(await locale()).toBe('de'); // the user's
    preferred = 'xx';
    expect(await locale()).toBe('en'); // not supported → the browser's
    await send('/choose/de');
    expect(await locale()).toBe('de'); // the session's
  });

  it('sends the fallback locale with the page — the browser falls back like the server (APP_FALLBACK_LOCALE, once)', async () => {
    const { send } = await boot({ env: { APP_FALLBACK_LOCALE: 'de' } });
    const response = await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'en' } });
    expect(await page(response)).toMatchObject({ locale: 'en', fallbackLocale: 'de' });
  });

  it('with one supported locale there is nothing to negotiate — and no Vary: accept-language for caches', async () => {
    const { send } = await boot({ env: { APP_LOCALES: 'en' } });
    await send('/choose/de'); // a session value of a locale the app does not have
    const response = await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de' } });
    expect(await page(response)).toMatchObject({ locale: 'en', props: { greeting: 'Hello Ada' } });
    expect(response.headers.get('content-language')).toBe('en');
    expect(response.headers.get('vary') ?? '').not.toMatch(/accept-language/);
    // Several: the answer depends on the browser's languages, and says so.
    const { send: several } = await boot();
    expect((await several('/hello', { headers: { [PAGE_HEADER]: 'true' } })).headers.get('vary')).toMatch(/accept-language/);
  });

  it("builds the request's translator only for a request that asks for one — one per request, whoever asks (W8 step 9)", async () => {
    const { send } = await boot();
    const built = vi.mocked(createTranslator);
    built.mockClear();
    expect(await (await send('/choose/de')).json()).toEqual({ ok: true }); // SetLocale ran, the session was written — no text in the answer
    expect(await (await send('/form', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).json()).toEqual({ ok: true });
    expect(built).not.toHaveBeenCalled();
    // A page: the controller, the page's locale and the session's epoch ask — one translator.
    expect((await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true' } }))).props.greeting).toBe('Hallo Ada');
    expect(built).toHaveBeenCalledTimes(1);
    // An error page speaks the request's language: it asks too.
    built.mockClear();
    expect((await send('/gone', { headers: { [PAGE_HEADER]: 'true' } })).status).toBe(404);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it('sets <html lang> of the document', async () => {
    const { send } = await boot();
    const html = await (await send('/hello', { headers: { accept: 'text/html', 'accept-language': 'de' } })).text();
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('"locale":"de"');
  });

  it('a malicious Accept-Language or session value never becomes a locale — no file, no markup', async () => {
    const { send, application } = await boot();
    const evil = ['../../../../etc/passwd', 'de"><script>alert(1)</script>', 'en/../../x', '__proto__', 'xx"/><svg onload=alert(1)>'];
    for (const value of evil) {
      const response = await send('/hello', { headers: { accept: 'text/html', 'accept-language': value } });
      const html = await response.text();
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('"locale":"en"'); // what the browser loads its language files by
      expect(html).not.toContain('<script>alert');
      expect(response.headers.get('content-language')).toBe('en');
    }
    // A session value is no better (the switcher of an app forgot to check it): with a header line break, too.
    await send(`/choose/${encodeURIComponent('de"><script>alert(1)</script>\r\nSet-Cookie: a=b')}`);
    const response = await send('/hello', { headers: { accept: 'text/html', 'accept-language': 'en' } });
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('"locale":"en"');
    expect(html).not.toContain('<script>alert');
    expect(response.headers.get('content-language')).toBe('en');
    // Only the supported locales' files were ever loaded (fr.ts exists, but is not in APP_LOCALES).
    expect(application.container.make(Catalog).locales().sort()).toEqual(['de', 'en']);
  });

  it('two requests at the same time keep their own locale', async () => {
    const run = async (override?: (container: Container) => void) => {
      const { send } = await boot({ override });
      const started = (id: string) => new Promise<void>((resolve) => arrived.set(id, resolve));
      const english = send('/slow/en1', { headers: { 'accept-language': 'en' } });
      await started('en1');
      // The German request starts — and finishes — while the English one waits between locale and translation.
      const german = send('/slow/de1', { headers: { 'accept-language': 'de' } });
      await started('de1');
      gates.get('de1')!();
      const de = await (await german).json();
      gates.get('en1')!();
      const en = await (await english).json();
      return { en, de };
    };

    expect(await run()).toEqual({ en: { locale: 'en', greeting: 'Hello en1' }, de: { locale: 'de', greeting: 'Hallo de1' } });
    // Counter-check — a naive translator shared by all requests (its locale a singleton): the English request answers in German.
    const naive = await run((c) => {
      const shared = new CurrentLocale('en');
      c.singleton(CurrentLocale, () => shared);
    });
    expect(naive.en).toEqual({ locale: 'de', greeting: 'Hallo en1' });
  });
});

describe('framework texts and validation in the request language', () => {
  it('German validation errors on the field — keys of the app, the rules of @bespokecore/auth, what the rule required', async () => {
    const { send } = await boot();
    const response = await send('/signup', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'accept-language': 'de' },
      body: JSON.stringify({ name: 'Al', email: 'nope', password: 'short' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      message: 'Der Name braucht mindestens 3 Zeichen. (und 2 weitere Fehler)',
      errors: {
        name: ['Der Name braucht mindestens 3 Zeichen.'],
        email: ['Bitte eine gültige E-Mail-Adresse eingeben.'],
        password: ['Das Passwort braucht mindestens 8 Zeichen.'],
      },
    });

    const english = await send('/signup', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'accept-language': 'en' },
      body: JSON.stringify({ name: 'Al', email: 'nope', password: 'short' }),
    });
    expect(((await english.json()) as { errors: unknown }).errors).toEqual({
      name: ['The name needs at least 3 characters.'],
      email: ['Enter a valid e-mail address.'],
      password: ['The password needs at least 8 characters.'],
    });
  });

  it('a form goes back with the errors in the session — in German', async () => {
    const { send } = await boot();
    const response = await send('/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'de', referer: 'http://localhost/hello' },
      body: new URLSearchParams({ name: 'Al', email: 'a@b.de', password: 'long enough' }),
    });
    expect(response.status).toBe(303);
    const back = await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de' } }));
    expect(back.props.errors).toEqual({ name: ['Der Name braucht mindestens 3 Zeichen.'] });
  });

  it('the error page and its title: 404, 419 (CSRF), translated by key', async () => {
    const { send } = await boot();
    const notFound = await page(await send('/gone', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de' } }));
    expect(notFound.props).toMatchObject({ status: 404, title: 'Nicht gefunden', message: 'Nicht gefunden' });
    const expired = await page(await send('/form', { method: 'POST', headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de' } }));
    expect(expired.props).toMatchObject({ status: 419, title: 'Seite abgelaufen', message: 'Die Seite ist abgelaufen. Bitte neu laden und noch einmal versuchen.' });
    const english = await page(await send('/form', { method: 'POST', headers: { [PAGE_HEADER]: 'true', 'accept-language': 'en' } }));
    expect(english.props).toMatchObject({ title: 'Page Expired', message: 'CSRF token mismatch.' });
  });

  it('a translated text is text: markup in a message or a value stays as written — the document escapes it', async () => {
    const { send } = await boot();
    const json = await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'de' } }));
    expect(json.props.html).toBe('Nutze <b>fett</b> & <img src=x onerror=alert(1)>');
    const html = await (await send('/hello', { headers: { accept: 'text/html', 'accept-language': 'de' } })).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('\\u003cimg src=x');
  });
});

describe('I18nConfig', () => {
  it('without APP_LOCALES, the supported locales are those the app has language files for — the default first', async () => {
    const { application, send } = await boot({ env: { APP_LOCALES: '', APP_LOCALE: 'de' } });
    expect(application.container.make(Locales).supported).toEqual(['de', 'en', 'fr']);
    expect((await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'fr' } }))).props.greeting).toBe('Bonjour Ada');
    expect((await page(await send('/hello', { headers: { [PAGE_HEADER]: 'true', 'accept-language': 'it' } }))).locale).toBe('de');
  });

  it('APP_LOCALE must be a supported locale', async () => {
    await expect(boot({ env: { APP_LOCALE: 'fr' } })).rejects.toThrow(ConfigError);
    await expect(boot({ env: { APP_LOCALE: 'fr' } })).rejects.toThrow(/APP_LOCALE must be one of APP_LOCALES/);
    await expect(boot({ env: { APP_LOCALES: 'en,../x' } })).rejects.toThrow(/language tags/);
  });

  it('forLocale: a translator for someone else — a mail in the recipient’s language', async () => {
    const { application } = await boot();
    const scope = application.container.createScope();
    const translator = scope.make(Translator);
    expect(translator.locale).toBe('en');
    expect(translator.forLocale('de').get('shop.greeting', { name: 'Grace' })).toBe('Hallo Grace');
    expect(translator.forLocale('fr').locale).toBe('en'); // not supported: the translator's own
    expect(translator.forLocale(null).locale).toBe('en');
    expect(translator.get('app.title')).toBe('Shop'); // lang/en.ts: namespace `app`
  });
});

describe('Translators — any locale, outside a request too', () => {
  it('is a root service: for(locale) is fixed to a supported locale, else APP_LOCALE', async () => {
    const { application } = await boot({ env: { APP_LOCALE: 'de' } });
    const translators = application.container.make(Translators); // no scope: a command, a job's constructor, a scheduler
    expect(translators.for('en').get('shop.greeting', { name: 'Ada' })).toBe('Hello Ada');
    expect(translators.for('DE').locale).toBe('de'); // in the app's spelling
    expect(translators.for('fr').locale).toBe('de'); // not supported (APP_LOCALES=en,de): APP_LOCALE, not the translator of whoever asks
    expect(translators.for(undefined).get('shop.greeting', { name: 'Ada' })).toBe('Hallo Ada');
    expect(translators.default.locale).toBe('de');
    expect(translators.for('en')).toBe(translators.for('en'));
    expect(translators.locales).toEqual(['de', 'en']);
  });

  it('a command resolves the Translator — it runs in a scope of its own (finding 3: never "scoped outside a scope")', async () => {
    const { run } = await import('@bespokecore/cli/main');
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      expect(await run(['fixture:greet'], join(import.meta.dirname, '__fixtures__', 'command-app'))).toBe(0);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    expect(err.join('')).toBe('');
    expect(out.join('')).toBe('de: Zu viele Versuche.\n'); // APP_LOCALE
  });

  it('a Translator outside a request — a job or a command scope — speaks APP_LOCALE', async () => {
    const { application } = await boot({ env: { APP_LOCALE: 'de' } });
    expect(() => application.container.make(Translator)).toThrow(/scoped and can only be resolved inside a scope/);
    expect(application.container.createScope().make(Translator).get('shop.greeting', { name: 'Ada' })).toBe('Hallo Ada');
  });
});

describe('Spike: Standard Schema options → Valibot', () => {
  it('Valibot 1.5 ignores libraryOptions of ~standard.validate (it reads only its global config) — so we translate per request', async () => {
    const schema = v.pipe(v.string(), v.minLength(3));
    v.setGlobalMessage(() => 'auf Deutsch', 'de');
    try {
      // Valibot's own API takes the language per call…
      expect(v.safeParse(schema, 'ab', { lang: 'de' }).issues?.[0]?.message).toBe('auf Deutsch');
      // …the Standard Schema interface (spec 1.1) does not get it through: still English.
      const validate = schema['~standard'].validate as (value: unknown, options?: StandardOptions) => ReturnType<typeof schema['~standard']['validate']>;
      const result = await validate('ab', { libraryOptions: { lang: 'de' } });
      expect(result.issues?.[0]?.message).toBe('Invalid length: Expected >=3 but received 2');
    } finally {
      v.deleteGlobalMessage('de');
    }
  });
});
