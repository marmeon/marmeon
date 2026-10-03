import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { tmpdir } from 'node:os';
import { Clock, defineModule, type ApplicationOptions } from '@bespokecore/core';
import { Controller, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { DevtoolsServiceProvider } from '@bespokecore/devtools';
import { ServerServiceProvider } from '@bespokecore/server';
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
  it("moves the app's time: every service reading the Clock sees app.travel() and app.freeze() (E97)", async () => {
    const app = await createTestApp(definition);
    const clock = app.container.make(Clock);
    expect(clock).toBe(app.clock);
    const frozen = app.freeze(new Date('2026-12-24T18:00:00Z'));
    expect(clock.now()).toBe(frozen);
    expect(app.travel({ minutes: 5 })).toBe(frozen + 300_000);
    app.travelTo(Date.UTC(2027, 0, 1));
    expect(new Date(clock.now()).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // Every test app has its own clock.
    const other = await createTestApp(definition);
    expect(Math.abs(other.container.make(Clock).now() - Date.now())).toBeLessThan(1_000);
  });

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

describe('closing a test app', () => {
  it('waits for terminate hooks, then shuts the app down — also via `await using`', async () => {
    const calls: string[] = [];
    const Recorder = class {
      shutdown() {
        calls.push('shutdown');
      }
    };
    const closing = { ...definition, providers: [...(definition.providers ?? []), Recorder] };
    {
      await using app = await createTestApp(closing);
      await app.get('/greeting').assertOk();
    }
    expect(calls).toEqual(['shutdown']);
    const app = await createTestApp(closing);
    await app.close();
    await app.close(); // shutting down twice is harmless
    expect(calls).toEqual(['shutdown', 'shutdown']);
  });
});

describe('server rendering assertions', () => {
  it('say how to turn server rendering on in tests', async () => {
    const app = await createTestApp(definition);
    expect(await failure(app.get('/greeting', { headers: { accept: 'text/html' } }).assertHydrates())).toContain(
      'assertHydrates() needs server rendering in the test: createTestApp(app, { ssr: true })',
    );
  });
});

describe('the devtools in tests (E115, E116)', () => {
  it('records into memory with devtools: true — app.devtools — and never without it', async () => {
    const withDevtools = { ...definition, providers: [...(definition.providers ?? []), ServerServiceProvider, DevtoolsServiceProvider] };
    const app = await createTestApp(withDevtools, { devtools: true });
    await app.get('/greeting').assertOk();
    const request = app.devtools.assertRecorded('request', (content) => content.path === '/greeting');
    expect(request.content.page).toMatchObject({ component: 'greetings/Show', props: { message: JSON.stringify('Hello Ada').length } });
    expect(() => app.devtools.assertRecorded('mail')).toThrow(/Expected the devtools to have recorded a mail\. Recorded 0 mail entries\./);

    const without = await createTestApp(withDevtools);
    expect(() => without.devtools).toThrow('app.devtools needs createTestApp(…, { devtools: true })');
  });

  it('says when the app does not register the devtools', async () => {
    await expect(createTestApp(definition, { devtools: true })).rejects.toThrow(/does not register @bespokecore\/devtools — add it to the app's package\.json/);
  });
});
