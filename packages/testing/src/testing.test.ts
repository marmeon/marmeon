import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { tmpdir } from 'node:os';
import { defineModule, type ApplicationOptions } from '@bespokecore/core';
import { Controller, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';

export class Greeting {
  text(name: string) {
    return `Hello ${name}`;
  }
}

export class ShowGreetingController extends Controller {
  readonly #greeting: Greeting;
  constructor(greeting: Greeting) {
    super();
    this.#greeting = greeting;
  }
  handle() {
    return this.view('greetings/Show', { message: this.#greeting.text('Ada'), meta: { lang: 'en', count: 1 } });
  }
}

const definition: ApplicationOptions = {
  root: tmpdir(),
  discover: false,
  env: { APP_KEY: generateKey() },
  providers: [EncryptionServiceProvider, HttpServiceProvider],
  modules: [
    defineModule({
      name: 'greetings',
      routes: defineRoutes((Route) => {
        Route.get('/greeting', ShowGreetingController);
        Route.post('/echo', async (ctx) => Response.json(await ctx.request.json(), { status: 201 }));
        Route.post('/upload', async (ctx) => {
          const { avatar, tags } = await ctx.input();
          const file = avatar as File;
          return { name: file.name, size: file.size, text: await file.text(), tags };
        });
        Route.post('/prefs', async (ctx) => {
          const { theme } = await ctx.input();
          if (theme) ctx.cookies.set('theme', String(theme));
          else ctx.cookies.delete('theme');
          return null;
        });
      }),
    }),
  ],
};

async function failure(check: PromiseLike<unknown>): Promise<string> {
  try {
    await check;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the assertion to fail');
}

describe('@bespokecore/testing', () => {
  it('chains assertions on the pending request (page loads and navigations)', async () => {
    const app = await createTestApp(definition);
    await app.get('/greeting').assertOk().assertSee('Hello Ada').assertPage('greetings/Show', { meta: { lang: 'en' } });
    await app.navigating().get('/greeting').assertHeader('x-bespoke', 'true').assertPage<ShowGreetingController>('greetings/Show', {
      message: 'Hello Ada',
    });
  });

  it('sends JSON and returns the awaited response', async () => {
    const app = await createTestApp(definition);
    const response = await app.post('/echo', { json: { a: 1 } }).assertCreated().assertExactJson({ a: 1 });
    expect(response.json()).toEqual({ a: 1 });
  });

  it('sends multipart bodies with files and repeated fields', async () => {
    const app = await createTestApp(definition);
    await app
      .post('/upload', { multipart: { avatar: new File(['hello'], 'ada.txt'), 'tags[]': ['a', 'b'] } })
      .assertOk()
      .assertExactJson({ name: 'ada.txt', size: 5, text: 'hello', tags: ['a', 'b'] });
  });

  it('asserts cookies that responses set, leave alone or expire', async () => {
    const app = await createTestApp(definition);
    await app.post('/prefs', { form: { theme: 'dark' } }).assertCookie('theme').assertCookie('theme', 'dark').assertCookieMissing('other');
    await app.withCookie('theme', 'dark').post('/prefs').assertCookieExpired('theme');

    expect(await failure(app.post('/prefs').assertCookie('theme'))).toContain('Expected cookie "theme" to be set, but it is expired');
    expect(await failure(app.post('/prefs', { form: { theme: 'x' } }).assertCookie('theme', 'dark'))).toContain(
      'Expected cookie "theme" = "dark", got "x"',
    );
    expect(await failure(app.post('/prefs', { form: { theme: 'x' } }).assertCookieExpired('theme'))).toContain(
      'Expected cookie "theme" to be expired',
    );
  });

  it('replaces services before boot', async () => {
    class LoudGreeting extends Greeting {
      override text(name: string) {
        return `HELLO ${name.toUpperCase()}`;
      }
    }
    const app = await createTestApp(definition, { override: (c) => c.instance(Greeting, new LoudGreeting()) });
    await app.navigating().get('/greeting').assertPage('greetings/Show', { message: 'HELLO ADA' });
  });

  it('explains failures with the request, status and body', async () => {
    const app = await createTestApp(definition);
    expect(await failure(app.get('/nope').assertOk())).toMatch(/^Expected status 200, got 404\n {2}GET \/nope → 404\n/);
    expect(await failure(app.navigating().get('/greeting').assertPage('greetings/Index'))).toContain(
      'Expected page "greetings/Index", got "greetings/Show"',
    );
    expect(await failure(app.navigating().get('/greeting').assertPage('greetings/Show', { meta: { count: 2 } }))).toContain(
      'Props of "greetings/Show" do not match',
    );
  });
});

// Never called: only the types matter.
export async function typeLevelTests(): Promise<void> {
  const app = await createTestApp(definition);
  // @ts-expect-error — `mesage` is not a prop of the page ShowGreetingController renders.
  await app.get('/greeting').assertPage<ShowGreetingController>('greetings/Show', { mesage: 'typo' });
  // @ts-expect-error — `count` is a number.
  await app.get('/greeting').assertPage<ShowGreetingController>('greetings/Show', { meta: { count: 'one' } });
  // Without a controller, any props are accepted:
  await app.get('/greeting').assertPage('greetings/Show', { anything: true });
}
