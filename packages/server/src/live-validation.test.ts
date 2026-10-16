import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import {
  AfterResponse,
  Controller,
  defineRequest,
  HttpServiceProvider,
  type ContextOf,
  type HttpContext,
} from '@marmeon/http';
import { ACTION_REDIRECT_HEADER, VALIDATE_HEADER, VALIDATED_HEADER } from '@marmeon/http/internal';
import type { Next } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };
const live = (...fields: string[]) => ({ ...JSON_HEADERS, [VALIDATE_HEADER]: fields.join(',') });

describe('createHttpKernel — live validation', async () => {
  const handled: string[] = [];
  const after: string[] = [];

  /**
   * A rule that needs the app (a uniqueness check): the schema is built per request with `resolve`. A schema of another library
   * (Valibot here) runs live only with `live: true` — the request's word that what it checks is no secret.
   */
  class Directory {
    static taken = ['ada@example.com'];
    has(email: string) {
      return Directory.taken.includes(email);
    }
  }

  const SignUpRequest = defineRequest({
    schema: (resolve) =>
      v.objectAsync({
        name: v.pipe(v.string(), v.minLength(2, 'At least 2 characters.')),
        email: v.pipeAsync(v.string(), v.trim(), v.toLowerCase(), v.email('Not an e-mail address.'), v.checkAsync(async (email) => !resolve(Directory).has(email), 'Taken.')),
        password: v.pipe(v.string(), v.minLength(8, 'At least 8 characters.')),
        address: v.optional(v.object({ city: v.pipe(v.string(), v.minLength(2, 'A city.')) })),
      }),
    live: true,
  });
  class SignUpController extends Controller {
    static request = SignUpRequest;
    handle(ctx: ContextOf<typeof SignUpRequest>) {
      handled.push(ctx.body.email);
      return this.redirect('/welcome');
    }
  }

  const UpdateRequest = defineRequest({
    schema: v.object({ name: v.pipe(v.string(), v.minLength(2, 'At least 2 characters.')) }),
    authorize: () => false,
  });
  class UpdateController extends Controller {
    static request = UpdateRequest;
    handle() {
      handled.push('update');
      return this.redirect('/');
    }
  }

  const SearchRequest = defineRequest({ query: v.object({ q: v.optional(v.string(), '') }) });
  class SearchController extends Controller {
    static request = SearchRequest;
    handle() {
      handled.push('search');
      return this.json({ results: [] });
    }
  }

  /** Middleware with side effects: a cookie, work after the response. */
  class Tracks {
    readonly #after: AfterResponse;
    constructor(after: AfterResponse) {
      this.#after = after;
    }
    async handle(ctx: HttpContext, next: Next<{}>) {
      ctx.cookies.set('tracked', 'yes');
      this.#after.defer(() => void after.push(new URL(ctx.request.url).pathname));
      return next();
    }
  }
  /** Sends everyone away — a guest-only form after signing in elsewhere. */
  class SendsAway {
    async handle() {
      return new Response(null, { status: 302, headers: { location: '/home' } });
    }
  }

  const routes = openRoutes((Route) => {
    Route.post('/sign-up', SignUpController).name('sign-up');
    Route.put('/profile', UpdateController).name('profile.update');
    Route.get('/search', SearchController).name('search');
    Route.post('/closure', () => {
      handled.push('closure');
      return null;
    });
    Route.middleware(Tracks).post('/tracked', SignUpController).name('tracked');
    Route.middleware(SendsAway).post('/away', SignUpController).name('away');
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'live', routes })],
  });
  const app = createHttpKernel(application, { debug: true, strictReadOnly: false });
  const strict = createHttpKernel(application, { debug: true });
  const post = (path: string, body: unknown, headers: Record<string, string>, kernel = app) =>
    kernel.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

  it('answers 204 for valid fields — and never runs the controller — no sign-up is handled', async () => {
    handled.length = 0;
    const response = await post('/sign-up', { name: 'Ada', email: 'grace@example.com', password: 'secret-pass' }, live('name', 'email'));
    expect(response.status).toBe(204);
    expect(response.headers.get(VALIDATED_HEADER)).toBe('name,email');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain(VALIDATE_HEADER);
    expect(handled).toEqual([]);
    // The same request without the header: the controller runs.
    expect((await post('/sign-up', { name: 'Ada', email: 'grace@example.com', password: 'secret-pass' }, JSON_HEADERS)).status).toBe(303);
    expect(handled).toEqual(['grace@example.com']);
  });

  it('answers 422 with the errors of the named fields only — never another field, never the input', async () => {
    const response = await post('/sign-up', { name: 'A', email: 'not-an-email', password: '' }, live('email'));
    expect(response.status).toBe(422);
    expect(response.headers.get(VALIDATED_HEADER)).toBe('email');
    const body = (await response.json()) as { errors: Record<string, string[]>; input?: unknown; old?: unknown };
    expect(body.errors).toEqual({ email: ['Not an e-mail address.'] });
    expect(JSON.stringify(body)).not.toContain('not-an-email');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('a field that is not filled in yet (the password: never sent) does not fail the named ones', async () => {
    const response = await post('/sign-up', { name: 'Ada', email: 'grace@example.com' }, live('name', 'email'));
    expect(response.status).toBe(204);
  });

  it('runs rules that need the app (a schema built per request): the same message as the submit', async () => {
    const checked = await post('/sign-up', { name: 'Ada', email: ' ADA@example.com ' }, live('email'));
    expect(checked.status).toBe(422);
    const submitted = await post('/sign-up', { name: 'Ada', email: ' ADA@example.com ', password: 'secret-pass' }, JSON_HEADERS);
    expect(submitted.status).toBe(422);
    expect(((await checked.json()) as { errors: unknown }).errors).toEqual(((await submitted.json()) as { errors: unknown }).errors);
  });

  it('a nested field: the issues under it count, a sibling outside it does not', async () => {
    const response = await post('/sign-up', { name: 'A', address: { city: 'X' } }, live('address'));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { errors: unknown }).errors).toEqual({ 'address.city': ['A city.'] });
  });

  it('authorization first: a forbidden route answers 403 — no field errors', async () => {
    handled.length = 0;
    const response = await strict.request('/profile', { method: 'PUT', headers: live('name'), body: JSON.stringify({ name: 'A' }) });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('errors');
    expect(handled).toEqual([]);
  });

  it('a route that validates no body — a GET, a closure, a request without schema — answers 400 and never runs', async () => {
    handled.length = 0;
    expect((await app.request('/search?q=x', { headers: live('q') })).status).toBe(400);
    expect((await post('/closure', {}, live('name'))).status).toBe(400);
    expect((await post('/sign-up', {}, live(' ', 'a b'))).status).toBe(400); // no usable field name left
    expect(handled).toEqual([]);
  });

  it('is read-only: a middleware cookie and work after the response are dropped (production) …', async () => {
    after.length = 0;
    const response = await post('/tracked', { name: 'Ada', email: 'grace@example.com' }, live('name'));
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBeNull();
    await app.settle();
    expect(after).toEqual([]);
    // The same route, submitted: the cookie and the deferred work happen.
    await post('/tracked', { name: 'Ada', email: 'grace@example.com', password: 'secret-pass' }, JSON_HEADERS);
    await app.settle();
    expect(after).toEqual(['/tracked']);
  });

  it('… and throw in development, naming the rule', async () => {
    const response = await post('/tracked', { name: 'Ada' }, live('name'), strict);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { message: string }).message).toContain("cookies.set('tracked') in a live validation (POST /tracked): a live validation is read-only");
  });

  it('a redirect of the route (middleware sending a guest away) is reported, not followed — and is no result', async () => {
    const response = await post('/away', { name: 'Ada' }, live('name'));
    expect(response.status).toBe(204);
    expect(response.headers.get(ACTION_REDIRECT_HEADER)).toBe('/home');
    expect(response.headers.get(VALIDATED_HEADER)).toBeNull();
    expect(response.headers.get('location')).toBeNull();
  });
});
