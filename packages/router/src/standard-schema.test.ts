import { defineConfig, resolveConfig, type StandardSchemaV1 } from '@marmeon/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRequest, parseQuery, ValidationError, type ContextOf } from './request-definition.ts';
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
