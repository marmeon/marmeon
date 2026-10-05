import { describe, expect, expectTypeOf, it } from 'vitest';
import { isPrefetch, PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER } from './page.ts';
import { partialReloadOf, resolvePageProps } from './page-props.ts';
import { always, deepMerge, defer, merge, optional } from './props.ts';
import { SharedData } from './shared-data.ts';
import { view, type PageProps } from './view.ts';

declare module './page.ts' {
  interface SharedProps {
    pageProps: { user: string | null };
    pagePropsErrors: Record<string, string[]>;
  }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/users/1', { headers });
}

function partial(component: string, only?: string, except?: string): Request {
  return request({
    [PAGE_HEADER]: 'true',
    [PARTIAL_COMPONENT_HEADER]: component,
    ...(only === undefined ? {} : { [PARTIAL_DATA_HEADER]: only }),
    ...(except === undefined ? {} : { [PARTIAL_EXCEPT_HEADER]: except }),
  });
}

/** Counts how often each prop is computed. */
function counted() {
  const calls: Record<string, number> = {};
  const count =
    <T>(name: string, value: T) =>
    () => {
      calls[name] = (calls[name] ?? 0) + 1;
      return value;
    };
  return { calls, count };
}

describe('partialReloadOf', () => {
  it('reads only/except for a page visit of the rendered component', () => {
    expect(partialReloadOf(partial('users/Show', 'stats, activity'), 'users/Show')).toEqual({ only: ['stats', 'activity'], except: [] });
    expect(partialReloadOf(partial('users/Show', undefined, 'links'), 'users/Show')).toEqual({ only: undefined, except: ['links'] });
  });

  it('ignores partial headers for another component, without x-bespoke, and without only/except', () => {
    expect(partialReloadOf(partial('users/Edit', 'stats'), 'users/Show')).toBeUndefined();
    expect(partialReloadOf(request({ [PARTIAL_COMPONENT_HEADER]: 'users/Show', [PARTIAL_DATA_HEADER]: 'stats' }), 'users/Show')).toBeUndefined();
    expect(partialReloadOf(partial('users/Show'), 'users/Show')).toBeUndefined();
  });

  it('takes an empty only as "no props" (always ones still come)', () => {
    expect(partialReloadOf(partial('users/Show', ''), 'users/Show')).toEqual({ only: [], except: [] });
  });
});

describe('resolvePageProps', () => {
  it('a full response: everything but optional and defer props, which are never computed — deferred ones are listed by group', async () => {
    const { calls, count } = counted();
    const page = await resolvePageProps(
      {
        profile: { id: 1 },
        lazy: count('lazy', 'computed'),
        stats: optional(count('stats', { links: 3 })),
        activity: defer(count('activity', ['signed in'])),
        audit: defer(count('audit', []), 'slow'),
        teams: defer(count('teams', []), 'slow'),
      },
      undefined,
      undefined,
    );
    expect(page).toEqual({ props: { profile: { id: 1 }, lazy: 'computed' }, deferredProps: { default: ['activity'], slow: ['audit', 'teams'] } });
    expect(calls).toEqual({ lazy: 1 });
  });

  it('a partial reload computes only what it asks for — shared props included', async () => {
    const { calls, count } = counted();
    const shared = new SharedData().share('pageProps', count('shared', { user: 'ada' }));
    const page = await resolvePageProps(
      { profile: count('profile', { id: 1 }), stats: optional(count('stats', { links: 3 })), activity: defer(count('activity', [])) },
      shared,
      partialReloadOf(partial('users/Show', 'stats'), 'users/Show'),
    );
    expect(page).toEqual({ props: { stats: { links: 3 } } }); // no deferredProps: that is for full responses
    expect(calls).toEqual({ stats: 1 }); // neither `profile` nor the shared prop was computed

    expect((await resolvePageProps({ profile: { id: 1 } }, shared, partialReloadOf(partial('users/Show', 'pageProps'), 'users/Show'))).props).toEqual({
      pageProps: { user: 'ada' },
    });
    expect(calls).toEqual({ stats: 1, shared: 1 });
  });

  it('sends always() props with every partial reload — even when not asked for, or excepted', async () => {
    const shared = new SharedData().share('pagePropsErrors', always(() => ({ name: ['Required.'] })));
    const only = await resolvePageProps({ profile: { id: 1 }, stats: optional(() => 1) }, shared, partialReloadOf(partial('users/Show', 'stats'), 'users/Show'));
    expect(only.props).toEqual({ pagePropsErrors: { name: ['Required.'] }, stats: 1 });
    const except = await resolvePageProps({ profile: { id: 1 } }, shared, partialReloadOf(partial('users/Show', undefined, 'pagePropsErrors,profile'), 'users/Show'));
    expect(except.props).toEqual({ pagePropsErrors: { name: ['Required.'] } });
  });

  it('except leaves out the named props — and never computes optional or defer props it does not name', async () => {
    const { calls, count } = counted();
    const page = await resolvePageProps(
      { profile: count('profile', 1), links: count('links', 2), stats: optional(count('stats', 3)), activity: defer(count('activity', 4)) },
      undefined,
      partialReloadOf(partial('users/Show', undefined, 'links'), 'users/Show'),
    );
    expect(page.props).toEqual({ profile: 1 });
    expect(calls).toEqual({ profile: 1 });
  });

  it('only filters what the controller returned: a prop it left out cannot be asked for', async () => {
    // The controller decides — e.g. the e-mail only for its owner. Asking for it by name changes nothing.
    const props = (owner: boolean) => ({ profile: { id: 1 }, ...(owner ? { email: 'ada@example.com' } : {}) });
    const asked = partialReloadOf(partial('users/Show', 'email,profile'), 'users/Show');
    expect((await resolvePageProps(props(false), undefined, asked)).props).toEqual({ profile: { id: 1 } });
    expect((await resolvePageProps(props(true), undefined, asked)).props).toEqual({ profile: { id: 1 }, email: 'ada@example.com' });
  });

  it('names merge and deepMerge props for the client', async () => {
    const page = await resolvePageProps({ links: merge([{ id: 3 }]), feed: deepMerge(() => ({ data: [1], meta: { page: 2 } })), other: 1 }, undefined, undefined);
    expect(page).toEqual({ props: { links: [{ id: 3 }], feed: { data: [1], meta: { page: 2 } }, other: 1 }, mergeProps: ['links'], deepMergeProps: ['feed'] });
    const reload = await resolvePageProps({ links: merge([{ id: 3 }]), feed: deepMerge({}) }, undefined, partialReloadOf(partial('x/Y', 'links'), 'x/Y'));
    expect(reload).toEqual({ props: { links: [{ id: 3 }] }, mergeProps: ['links'] }); // only what is sent
  });

  it('names the keys merged arrays match their items on (matchOn) — per prop, with its path', async () => {
    const people = { data: [{ id: 1, name: 'Ada' }], meta: { nextCursor: 'c2' } };
    const page = await resolvePageProps(
      { links: merge([{ id: 3 }]).matchOn('id'), others: deepMerge(() => people).matchOn('data.id'), tags: merge(['a']) },
      undefined,
      undefined,
    );
    expect(page).toMatchObject({ mergeProps: ['links', 'tags'], deepMergeProps: ['others'], matchPropsOn: ['links.id', 'others.data.id'] });
  });

  it('defer(…).merge(): left out of the first response like any deferred prop — merged (and matched) once it is sent', async () => {
    const { calls, count } = counted();
    const props = { feed: defer(count('feed', [{ id: 1 }]), 'feed').merge().matchOn('id'), chart: defer(() => ({ a: { b: [1] } })).deepMerge() };
    const first = await resolvePageProps(props, undefined, undefined);
    expect(first).toEqual({ props: {}, deferredProps: { feed: ['feed'], default: ['chart'] } });
    expect(calls).toEqual({});
    const loaded = await resolvePageProps(props, undefined, partialReloadOf(partial('x/Y', 'feed,chart'), 'x/Y'));
    expect(loaded).toEqual({ props: { feed: [{ id: 1 }], chart: { a: { b: [1] } } }, mergeProps: ['feed'], deepMergeProps: ['chart'], matchPropsOn: ['feed.id'] });
  });

  it("lets a controller's prop win over a shared one of the same name", async () => {
    const shared = new SharedData().share('pageProps', () => ({ user: 'shared' }));
    expect((await resolvePageProps({ pageProps: { user: 'own' } }, shared, undefined)).props).toEqual({ pageProps: { user: 'own' } });
  });
});

describe('isPrefetch', () => {
  it('tells a prefetch (ours: Purpose, the browser’s: Sec-Purpose) from the visit', () => {
    expect(isPrefetch(request({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetch(request({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true);
    expect(isPrefetch(request({ 'sec-purpose': 'prefetch' }))).toBe(true);
    expect(isPrefetch(request())).toBe(false);
    expect(isPrefetch(request({ purpose: 'prefetcher' }))).toBe(false);
  });
});

describe('PageProps with wrapped props', () => {
  class Show {
    handle() {
      return view('users/Show', {
        profile: { id: Number(1), joined: new Date() },
        lazy: () => ({ total: 3 }),
        asyncLazy: async () => ({ at: new Date() }),
        stats: optional(async () => ({ links: 3 })),
        activity: defer(() => [{ at: new Date(), what: 'signed in' }]),
        links: merge([{ id: 1, url: 'https://example.com' }]),
        feed: deepMerge(() => ({ data: [1, 2] })),
        flag: always(true),
        people: deepMerge(async () => ({ data: [{ id: 1, joined: new Date() }], meta: { next: 'c2' } })).matchOn('data.id'),
        later: defer(() => [{ id: 1 }]).merge().matchOn('id'),
      });
    }
  }

  it('unwraps them — optional and defer as possibly missing — and still serializes', () => {
    type Props = PageProps<Show>;
    expectTypeOf<Props['profile']>().toEqualTypeOf<{ readonly id: number; readonly joined: string }>();
    expectTypeOf<Props['lazy']>().toEqualTypeOf<{ total: number }>();
    expectTypeOf<Props['asyncLazy']>().toEqualTypeOf<{ at: string }>();
    expectTypeOf<Props['stats']>().toEqualTypeOf<{ links: number } | undefined>();
    expectTypeOf<Props['activity']>().toEqualTypeOf<{ at: string; what: string }[] | undefined>();
    expectTypeOf<Props['links']>().toEqualTypeOf<{ id: number; url: string }[]>();
    expectTypeOf<Props['feed']>().toEqualTypeOf<{ data: number[] }>();
    expectTypeOf<Props['flag']>().toEqualTypeOf<boolean>();
    expectTypeOf<Props['people']>().toEqualTypeOf<{ data: { id: number; joined: string }[]; meta: { next: string } }>();
    expectTypeOf<Props['later']>().toEqualTypeOf<{ id: number }[] | undefined>();
    // Possibly missing — a view has to handle `undefined` before using it.
    const use = (props: Props) => {
      // @ts-expect-error -- 'props.stats' is possibly 'undefined'
      void props.stats.links;
      void props.stats?.links;
    };
    void use;
  });

  it('checks matchOn keys against the merged value', () => {
    const check = () => {
      // @ts-expect-error -- Argument of type '"uid"' is not assignable to parameter of type '"id" | "url"'.
      merge([{ id: 1, url: 'x' }]).matchOn('uid');
      // A shallow merge appends a top-level array and a paginator's data (W9): 'data.id' and a path into the items are fine.
      merge({ data: [{ id: 1 }], meta: {} }).matchOn('data.id');
      merge([{ user: { id: 1 } }]).matchOn('user.id');
      // @ts-expect-error -- Argument of type '"data.uid"' is not assignable to parameter of type '"data.id"'.
      merge({ data: [{ id: 1 }] }).matchOn('data.uid');
      // @ts-expect-error -- a list deeper than a paginator's data needs deepMerge: '"a.data.id"' is not assignable to parameter of type 'never'.
      merge({ a: { data: [{ id: 1 }] } }).matchOn('a.data.id');
      // @ts-expect-error -- Argument of type '"data.uid"' is not assignable to parameter of type '"data.id"'.
      deepMerge(() => ({ data: [{ id: 1 }], meta: { next: null } })).matchOn('data.uid');
      // @ts-expect-error -- matchOn only on a merging deferred prop: Property 'matchOn' does not exist on type 'DeferredProp<…>'.
      defer(() => [{ id: 1 }]).matchOn('id');
    };
    void check;
  });

  it('types shared wrapped values against SharedProps', () => {
    const shared = new SharedData();
    shared.share('pagePropsErrors', always(() => ({ name: ['x'] })));
    // @ts-expect-error -- a string is no Record<string, string[]>
    shared.share('pagePropsErrors', always('x'));
    // @ts-expect-error -- optional() makes a prop possibly missing, which `pageProps` is not declared as
    shared.share('pageProps', optional(() => ({ user: null })));
  });
});
