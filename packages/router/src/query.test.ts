import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRequest, parseQuery, queryInput, type ContextOf, type QueryOf } from './request-definition.ts';
import { Route } from './route.ts';
import { Router, type ResponseContext } from './router.ts';
import type { EmptyObject, HttpContext } from './types.ts';
import { toSearchParams, type Query } from './url.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const SORTS = ['name', '-name', 'last_login', '-last_login'] as const;

/** The query of the people list in the web app — every form a query field takes. */
const peopleQuery = v.object({
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), ''),
  sort: v.optional(v.picklist(SORTS), 'name'),
  page: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)), '1'),
  archived: v.optional(v.pipe(v.string(), v.parseBoolean()), 'false'),
  tag: v.optional(v.array(v.picklist(['admin', 'staff', 'guest'])), []),
  cursor: v.optional(v.string()),
});

const ListPeopleRequest = defineRequest({ query: peopleQuery });
const CanonicalPeopleRequest = defineRequest({ query: peopleQuery, queryOptions: { onInvalid: 'redirect' } });

class ListPeopleController {
  static request = ListPeopleRequest;
  handle(ctx: ContextOf<typeof ListPeopleRequest>) {
    return { query: ctx.query };
  }
}

class CanonicalPeopleController {
  static request = CanonicalPeopleRequest;
  handle(ctx: ContextOf<typeof CanonicalPeopleRequest>) {
    return { query: ctx.query };
  }
}

const parse = async (search: string) => parseQuery(peopleQuery, new URLSearchParams(search));

describe('query schema', () => {
  it('parses the query: defaults filled in, strings turned into numbers, booleans and lists', async () => {
    const parsed = await parse('q=%20ada%20&sort=-name&page=3&archived=true&tag=admin&tag=staff');
    expect(parsed.value).toEqual({ q: 'ada', sort: '-name', page: 3, archived: true, tag: ['admin', 'staff'] });
    expect(parsed.dropped).toEqual([]);
    expect((await parse('')).value).toEqual({ q: '', sort: 'name', page: 1, archived: false, tag: [] });
  });

  it('an invalid field falls back to its default — the others stay, nothing answers 422', async () => {
    const parsed = await parse('sort=DROP%20TABLE&page=0&q=ada&archived=maybe');
    expect(parsed.value).toEqual({ q: 'ada', sort: 'name', page: 1, archived: false, tag: [] });
    expect([...parsed.dropped].sort()).toEqual(['archived', 'page', 'sort']);
    // Without the fallback, the schema alone rejects it (what would be a 422).
    expect((await peopleQuery['~standard'].validate(queryInput(new URLSearchParams('sort=DROP%20TABLE')))).issues).toBeDefined();
  });

  it('reads a repeated key as a list, in linear time', () => {
    expect(queryInput(new URLSearchParams('tag=a')).tag).toBe('a');
    expect(queryInput(new URLSearchParams('tag=a&tag=b')).tag).toEqual(['a', 'b']);

    const count = 50_000;
    const started = performance.now();
    const input = queryInput(new URLSearchParams('tag=x&'.repeat(count)));
    expect(input.tag).toHaveLength(count);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('takes one value as a list of one where the schema wants a list, and drops a list where it wants one value', async () => {
    expect((await parse('tag=admin')).value.tag).toEqual(['admin']);
    expect((await parse('tag=admin&tag=root')).value.tag).toEqual([]);
    const twice = await parse('sort=-name&sort=name');
    expect(twice.value.sort).toBe('name');
    expect(twice.dropped).toEqual(['sort']);
  });

  it('leaves unknown keys and defaults out of the canonical query (what the page object carries)', async () => {
    const parsed = await parse('utm_source=mail&sort=name&q=ada&page=2');
    expect(parsed.canonical).toEqual({ q: 'ada', page: 2 });
    expect(parsed.defaults).toEqual({ q: '', sort: 'name', page: 1, archived: false, tag: [] });
    expect(parsed.dropped).toEqual(['utm_source']);
  });

  it('round-trip: what a link writes into the URL (toSearchParams) parses back to the same value — for every field form', async () => {
    const values: Query[] = [
      { q: 'Ada Lovelace', sort: '-last_login', page: 7, archived: true, tag: ['staff', 'guest'], cursor: 'eyJpZCI6M30' },
      { q: 'x&y=z?#', sort: 'name', page: 1, archived: false, tag: ['admin'] },
      { q: 'ümlaut ß', tag: [] },
      {},
    ];
    for (const value of values) {
      const parsed = await parse(toSearchParams(value).toString());
      expect(parsed.dropped).toEqual([]);
      expect(parsed.value).toEqual({ ...parsed.defaults, ...value });
    }
  });

  it('is no place for prototype pollution', async () => {
    const parsed = await parse('__proto__=x&constructor=y');
    expect(parsed.value).toEqual(parsed.defaults);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('refuses a schema that an empty query fails, naming the field (the types refuse it first)', async () => {
    const partial = v.object({ page: v.string() });
    await expect(parseQuery(partial, new URLSearchParams('page=2'))).rejects.toThrow(
      "A query schema must accept an empty query — every field needs a default or must be optional ('page' is required)",
    );
  });

  describe('on a route', () => {
    const router = new Router().load(
      openRoutes((Route) => {
        Route.get('/people', ListPeopleController);
        Route.get('/members', CanonicalPeopleController);
        Route.post('/people', ListPeopleController); // a query schema on a POST: parsed too, never redirected
      }),
    );
    let seen: ResponseContext | undefined;
    const dispatch = (method: string, path: string) => {
      const route = router.routes.find((r) => r.path === path.split('?')[0] && r.methods.includes(method as 'GET'))!;
      return router.dispatch(
        route,
        { request: new Request(`http://app.test${path}`, { method }), params: {} },
        {
          toResponse: (result, ctx) => {
            seen = ctx;
            return Response.json(result);
          },
        },
      );
    };

    it('hands handle() the parsed query as ctx.query, and the response factory the page query', async () => {
      const response = await dispatch('GET', '/people?sort=-name&page=2&nope=1');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ query: { q: '', sort: '-name', page: 2, archived: false, tag: [] } });
      expect(seen?.pageQuery).toEqual({ values: { sort: '-name', page: 2 }, defaults: { q: '', sort: 'name', page: 1, archived: false, tag: [] } });
    });

    it('falls back to the default for ?sort=DROP TABLE — 200, never a 422', async () => {
      const response = await dispatch('GET', '/people?sort=DROP%20TABLE');
      expect(response.status).toBe(200);
      expect(((await response.json()) as { query: { sort: string } }).query.sort).toBe('name');
    });

    it("onInvalid: 'redirect' → 302 to the canonical URL, without the broken or unknown keys (GET only)", async () => {
      const response = await dispatch('GET', '/members?sort=DROP%20TABLE&q=ada&page=2&utm=x');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/members?q=ada&page=2');
      expect((await dispatch('GET', '/members?sort=nope')).headers.get('location')).toBe('/members');
      // Valid (an explicit default is no error): no redirect.
      expect((await dispatch('GET', '/members?sort=name&q=ada')).status).toBe(200);
    });

    it('parses the query of other methods too — and falls back there, never redirecting', async () => {
      const response = await dispatch('POST', '/people?sort=bad&page=4');
      expect(response.status).toBe(200);
      expect(((await response.json()) as { query: { sort: string; page: number } }).query).toMatchObject({ sort: 'name', page: 4 });
    });

    it('keeps a raw URLSearchParams in ctx.query without a query schema', async () => {
      const raw = new Router().load(openRoutes((Route) => Route.get('/raw', (ctx) => ({ q: ctx.query.get('q') }))));
      const response = await raw.dispatch(raw.routes[0]!, { request: new Request('http://app.test/raw?q=ada'), params: {} });
      expect(await response.json()).toEqual({ q: 'ada' });
    });

    it('refuses a GET route whose request validates a body — at boot, for code the types did not check', () => {
      const WithBody = defineRequest({ schema: v.object({ name: v.string() }) });
      class ShowWithBodyController {
        static request = WithBody;
        handle() {
          return null;
        }
      }
      expect(() => new Router().load(openRoutes((Route) => (Route.get as (path: string, action: unknown) => void)('/show', ShowWithBodyController)))).toThrow(
        'Route GET /show: a GET request has no body — validate its URL with `query` (defineRequest({ query })) — ShowWithBodyController has a body schema.',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Type guarantees. Never called.
// ---------------------------------------------------------------------------

declare const GuestRoute: Route<EmptyObject>;

export function queryTypeTests(): void {
  // ctx.query is the schema's output, defaults filled in.
  expectTypeOf<QueryOf<ListPeopleController>>().toEqualTypeOf<{
    q: string;
    sort: 'name' | '-name' | 'last_login' | '-last_login';
    page: number;
    archived: boolean;
    tag: ('admin' | 'staff' | 'guest')[];
    cursor?: string | undefined;
  }>();
  GuestRoute.get('/people', ListPeopleController);

  // A body schema on a GET route: a GET request has no body.
  const ShowRequest = defineRequest({ schema: v.object({ name: v.string() }) });
  class ShowController {
    static request = ShowRequest;
    handle(ctx: ContextOf<typeof ShowRequest>) {
      return ctx.body.name;
    }
  }
  // @ts-expect-error -- 1: "a GET request has no body — validate its URL with `query` (defineRequest({ query }))"
  GuestRoute.get('/show', ShowController);
  GuestRoute.post('/show', ShowController); // fine on a POST

  // A query field without a default: an invalid one would have nothing to fall back to.
  // @ts-expect-error -- 2: "query fields need a default or must be optional: 'page' is required"
  defineRequest({ query: v.object({ page: v.string() }) });

  // A query field the URL can never fill: the URL has strings.
  // @ts-expect-error -- 3: "query fields are read from the URL as strings: 'page' does not take one — parse the string, …"
  defineRequest({ query: v.object({ page: v.optional(v.number(), 1) }) });

  // An output a link cannot write back into the URL.
  // @ts-expect-error -- 4: "query field 'since' cannot go back into a URL — a query value is a string, number, boolean or an array of them"
  defineRequest({ query: v.object({ since: v.optional(v.pipe(v.string(), v.toDate())) }) });

  // A handler that reads the raw query behind a query schema reads what is not there.
  class RawReader {
    static request = ListPeopleRequest;
    handle(ctx: HttpContext & { query: URLSearchParams }) {
      return ctx.query.get('q');
    }
  }
  // @ts-expect-error -- 5: ctx.query is the parsed query, not URLSearchParams
  GuestRoute.get('/raw', RawReader);
}
