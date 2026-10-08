import { defineConfig, resolveConfig, type StandardSchemaV1 } from '@marmeon/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRequest, parseQuery, ValidationError, type ContextOf } from './request-definition.ts';
import { VALIDATE_HEADER } from './live-validation.ts';
import { defineRoutes, Router } from './router.ts';

/**
 * A schema of another library, as Zod 4 builds them (W10 step 3): Standard Schema and nothing else of ours — its own vendor, its
 * own issues (paths as `{ key }` segments), no use for `libraryOptions`. The framework's one contract is Standard Schema (E197):
 * `rules` of @marmeon/validation are what the docs show, never a must.
 */
type Field<T> = (value: unknown) => { value: T } | { message: string };

function zodLike<const S extends Record<string, Field<any>>>(shape: S): StandardSchemaV1<Record<string, unknown>, { [K in keyof S]: S[K] extends Field<infer T> ? T : never }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'zod',
      validate: (input: unknown) => {
        const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        const value: Record<string, unknown> = {};
        const issues: { message: string; path: { key: string }[] }[] = [];
        for (const [key, field] of Object.entries(shape)) {
          const result = field(source[key]);
          if ('message' in result) issues.push({ message: result.message, path: [{ key }] });
          else value[key] = result.value;
        }
        return issues.length > 0 ? { issues } : { value: value as never };
      },
    },
  };
}

const text: Field<string> = (value) => (typeof value === 'string' && value !== '' ? { value } : { message: 'Required' });
const page: Field<number> = (value) => (value === undefined ? { value: 1 } : /^[1-9]\d*$/.test(String(value)) ? { value: Number(value) } : { message: 'Expected a page' });
const port: Field<number> = (value) => (value === undefined ? { value: 3000 } : /^\d+$/.test(String(value)) ? { value: Number(value) } : { message: 'Expected a port' });

const CreateNoteRequest = defineRequest({ schema: zodLike({ title: text }) });
class CreateNoteController {
  static request = CreateNoteRequest;
  handle(ctx: ContextOf<typeof CreateNoteRequest>) {
    expectTypeOf(ctx.body.title).toEqualTypeOf<string>();
    return ctx.body;
  }
}

describe('another library\'s Standard Schema (Zod-like) works where rules do (E197)', () => {
  const router = new Router().load(defineRoutes((Route) => Route.post('/notes', CreateNoteController)));
  const post = (body: unknown) =>
    router.dispatch(router.routes[0]!, { request: new Request('http://app.test/notes', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params: {} });

  it('defineRequest: the body validated, its issues the form\'s errors (by their { key } paths)', async () => {
    expect(await (await post({ title: 'Hello' })).json()).toEqual({ title: 'Hello' });
    const error = (await post({}).catch((failure: unknown) => failure)) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.errors).toEqual({ title: ['Required'] });
  });

  it('parseQuery: an invalid field falls back (E56) — by the issue paths, with any library', async () => {
    const parsed = await parseQuery(zodLike({ page }), new URLSearchParams('page=x'));
    expect(parsed.value).toEqual({ page: 1 });
    expect(parsed.dropped).toEqual(['page']);
    expect((await parseQuery(zodLike({ page }), new URLSearchParams('page=3'))).value).toEqual({ page: 3 });
  });

  it('defineConfig: the environment validated, problems by variable', async () => {
    const ServerConfig = defineConfig('server', { env: zodLike({ PORT: port }), resolve: (env) => ({ port: env.PORT }) });
    expect((await resolveConfig([ServerConfig], { PORT: '8080' })).get(ServerConfig)).toEqual({ port: 8080 });
    await expect(resolveConfig([ServerConfig], { PORT: 'eighty' })).rejects.toThrow('• server: PORT — Expected a port');
  });
});

describe('another library\'s schema in a live validation: fail-closed (E206)', () => {
  // A Zod-like schema whose refine asks "the database" whether an address is taken — what the router README once recommended.
  const taken = new Set(['ada@example.com']);
  let calls = 0;
  const signUp = (): StandardSchemaV1 => ({
    '~standard': {
      version: 1,
      vendor: 'zod',
      validate: async (input: unknown) => {
        calls++;
        const email = (input as { email?: unknown }).email;
        if (typeof email !== 'string' || !email.includes('@')) return { issues: [{ message: 'Invalid email', path: [{ key: 'email' }] }] };
        return taken.has(email) ? { issues: [{ message: 'Email already taken', path: [{ key: 'email' }] }] } : { value: { email } };
      },
    },
  });
  class SignUp {
    static request = defineRequest({ schema: signUp() });
    handle() {
      return 'created';
    }
  }
  class TeamSlug {
    // Opted in on purpose: whether a slug is taken is no secret here.
    static request = defineRequest({ schema: signUp(), live: true });
    handle() {
      return 'created';
    }
  }
  const router = new Router().load(
    defineRoutes((Route) => {
      Route.post('/sign-up', SignUp);
      Route.post('/slug', TeamSlug);
    }),
  );
  const live = async (path: string, email: string) => {
    const route = router.routes.find((candidate) => candidate.path === path)!;
    const request = new Request(`http://app.test${path}`, { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json', [VALIDATE_HEADER]: 'email' } });
    try {
      const response = await router.dispatch(route, { request, params: {} });
      return { status: response.status };
    } catch (error) {
      if (error instanceof ValidationError) return { status: 422, errors: error.errors };
      throw error;
    }
  };

  it('without `live: true` the schema never runs live — a free and a taken address get the same 204', async () => {
    calls = 0;
    const answers = [await live('/sign-up', 'ada@example.com'), await live('/sign-up', 'grace@example.com'), await live('/sign-up', 'nope')];
    expect(answers, 'a live validation ran a foreign schema').toEqual([{ status: 204 }, { status: 204 }, { status: 204 }]);
    expect(calls, 'the foreign schema ran in a live validation').toBe(0);
  });

  it('`live: true` lets it run — and it tells (the opt-in is the app\'s word that nothing secret is asked)', async () => {
    calls = 0;
    expect(await live('/slug', 'ada@example.com')).toEqual({ status: 422, errors: { email: ['Email already taken'] } });
    expect(await live('/slug', 'grace@example.com')).toEqual({ status: 204 });
    expect(calls).toBe(2);
  });
});
