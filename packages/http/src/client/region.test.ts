import { LOCATION_HEADER, PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, REGION_HEADER, REGION_STATUS_HEADER, VERSION_HEADER, type RegionObject, PROTOCOL_VERSION } from '../protocol.ts';
import { describe, expect, it } from 'vitest';
import { regionId, regionInitial } from './region.ts';
import { boot, FakeWindow, keptRegions, ORIGIN, page, pageResponse, settle } from './test-window.ts';
import { prefetch } from './features/prefetch.ts';
import { islands } from './features/islands.ts';

const island = (url: string, props: Record<string, unknown> = {}, extra: Partial<RegionObject> = {}): RegionObject => ({
  component: 'dashboard/RecentSignIns',
  props,
  url,
  version: null,
  ...extra,
});

const islandResponse = (body: RegionObject) =>
  new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island', 'content-type': 'application/json' } });

const outcome = (status: 'unauthorized' | 'forbidden') => new Response(null, { status: 204, headers: { [REGION_STATUS_HEADER]: status } });

/** A response that resolves when `release()` is called — to hold a request under way. */
function held() {
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => (release = resolve));
  return { response, release };
}

const islandRequests = (win: FakeWindow) => win.requests.filter((request) => request.headers[REGION_HEADER] === 'island');

describe('Region — islands in the client core', () => {
  it('loads an island with the page headers, x-marmeon-region and the asset version — never following a redirect', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    let init: RequestInit | undefined;
    win.handler = (url, given) => {
      init = given;
      return islandResponse(island(new URL(url).pathname + new URL(url).search, { entries: ['ada'] }));
    };
    const { navigator } = boot(win, { ...page('/dashboard', {}, 'dashboard/Show'), version: 'v1' });
    const region = navigator.use(islands).region('/dashboard/islands/sign-ins?limit=5');
    expect(region.snapshot.status).toBe('loading');
    await region.load();

    expect(region.snapshot).toMatchObject({ status: 'ready', pending: false, region: { component: 'dashboard/RecentSignIns', props: { entries: ['ada'] } } });
    expect(islandRequests(win)).toEqual([
      { url: `${ORIGIN}/dashboard/islands/sign-ins?limit=5`, method: 'GET', headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island', [VERSION_HEADER]: 'v1' } },
    ]);
    expect(init?.redirect).toBe('manual');
  });

  it('two identical islands share one request (and one state)', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url) => islandResponse(island(new URL(url).pathname + new URL(url).search));
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const one = navigator.use(islands).region('/dashboard/islands/sign-ins?limit=5&range=7d');
    const two = navigator.use(islands).region('/dashboard/islands/sign-ins?range=7d&limit=5'); // the same island, the query in another order
    await Promise.all([one.load(), two.load()]);
    expect(two).toBe(one);
    expect(islandRequests(win)).toHaveLength(1);
    expect(regionId('/a?b=2&a=1')).toBe('/a?a=1&b=2');
  });

  it('islands load in parallel — a slow one blocks nobody', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const slow = held();
    win.handler = (url) => (url.includes('members') ? slow.response : islandResponse(island(new URL(url).pathname)));
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const members = navigator.use(islands).region('/dashboard/islands/members');
    const signIns = navigator.use(islands).region('/dashboard/islands/sign-ins');
    void members.load();
    await signIns.load();
    expect(islandRequests(win)).toHaveLength(2);
    expect([signIns.snapshot.status, members.snapshot.status]).toEqual(['ready', 'loading']);
    slow.release(islandResponse(island('/dashboard/islands/members', { stats: 3 }, { component: 'dashboard/MemberStats' })));
    await settle();
    expect(members.snapshot.status).toBe('ready');
  });

  it('Back shows the islands of the entry from memory — no request, and none of their props in history.state', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url) =>
      url.includes('/islands/') ? islandResponse(island(new URL(url).pathname, { secret: 'only-in-memory' })) : pageResponse(page('/people', {}, 'user-profile/People'));
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    await navigator.use(islands).region('/dashboard/islands/sign-ins').load();
    await navigator.visit('/people');
    const requests = win.requests.length;

    win.back();
    await settle();
    // What the adapter does for the page it renders again: the island of its entry — ready, from memory.
    const again = navigator.use(islands).region('/dashboard/islands/sign-ins', { owner: owner() });
    expect(again.snapshot).toMatchObject({ status: 'ready', region: { props: { secret: 'only-in-memory' } } });
    await again.load();
    expect(win.requests.length).toBe(requests);
    for (const { state } of win.entries) expect(state).not.toContain('only-in-memory');
  });

  it('an island still loading when the page changes is aborted — it never lands in the next page', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const slow = held();
    let aborted = false;
    win.handler = (url, init) => {
      if (!url.includes('/islands/')) return pageResponse(page('/people', {}, 'user-profile/People'));
      init.signal?.addEventListener('abort', () => (aborted = true));
      return slow.response;
    };
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const first = owner();
    const region = navigator.use(islands).region('/dashboard/islands/sign-ins');
    void region.load();
    await navigator.visit('/people');
    expect(aborted).toBe(true);
    slow.release(islandResponse(island('/dashboard/islands/sign-ins', { late: true })));
    await settle();
    expect(region.snapshot.region).toBeUndefined();
    expect(first.closed).toBe(true);
    // The next page's entry has no island of the one before.
    expect(keptRegions(navigator, owner()).size).toBe(0);
    expect(navigator.use(islands).region('/dashboard/islands/sign-ins').snapshot.status).toBe('loading');
  });

  it('a redirect, 401 or 403 of an island is its outcome — the page never navigates', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const answers: Record<string, () => Response> = {
      '/i/unauthorized': () => outcome('unauthorized'),
      '/i/forbidden': () => outcome('forbidden'),
      // Not turned by the server (a proxy in between): a redirect, a 401, a 403 — never followed, never a navigation.
      '/i/redirect': () => new Response(null, { status: 302, headers: { location: '/login' } }),
      '/i/opaque': () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' }),
      '/i/401': () => Response.json({ message: 'Unauthenticated.' }, { status: 401 }),
      '/i/403': () => Response.json({ message: 'This action is unauthorized.' }, { status: 403 }),
    };
    win.handler = (url) => answers[new URL(url).pathname]!();
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const statuses: Record<string, string> = {};
    for (const path of Object.keys(answers)) {
      const region = navigator.use(islands).region(path);
      await region.load();
      statuses[path] = region.snapshot.status;
    }
    expect(statuses).toEqual({
      '/i/unauthorized': 'unauthorized',
      '/i/forbidden': 'forbidden',
      '/i/redirect': 'unauthorized',
      '/i/opaque': 'unauthorized',
      '/i/401': 'unauthorized',
      '/i/403': 'forbidden',
    });
    expect(win.loads).toEqual([]);
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/dashboard`]);
    expect(navigator.page.component).toBe('dashboard/Show');
  });

  it('a 5xx of one island is that island’s failure — the page and the other islands stay', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url) =>
      url.includes('broken') ? Response.json({ message: 'Database down' }, { status: 500, headers: { [REGION_STATUS_HEADER]: 'exception' } }) : islandResponse(island(new URL(url).pathname));
    const { navigator } = boot(win, page('/dashboard', { stays: true }, 'dashboard/Show'));
    const exceptions: unknown[] = [];
    navigator.on('exception', (exception) => exceptions.push(exception));
    const broken = navigator.use(islands).region('/islands/broken');
    const fine = navigator.use(islands).region('/islands/fine');
    await Promise.all([broken.load(), fine.load()]);
    expect(broken.snapshot).toMatchObject({ status: 'exception', failure: { status: 500, message: 'Database down' } });
    expect(fine.snapshot.status).toBe('ready');
    // No visit failed: the page's own failure notice (the `exception` event) is not shown for an island.
    expect(exceptions).toEqual([]);
    expect(navigator.page.props).toEqual({ stays: true });
    expect(win.loads).toEqual([]);
  });

  it('a failed reload keeps what the island shows; offline is a failure without a status', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    let offline = false;
    win.handler = (url) => {
      if (offline) throw new TypeError('Failed to fetch');
      return islandResponse(island(new URL(url).pathname, { n: 1 }));
    };
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/activity');
    await region.load();
    offline = true;
    await region.reload();
    expect(region.snapshot).toMatchObject({ status: 'ready', region: { props: { n: 1 } }, failure: { status: undefined } });
  });

  it('signed out elsewhere: a reload answered `unauthorized` takes away what the island showed — from the screen and from memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    let signedOut = false;
    win.handler = (url) => (signedOut ? outcome('unauthorized') : islandResponse(island(new URL(url).pathname, { private: true })));
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/activity');
    await region.load();
    signedOut = true;
    await region.reload();
    expect(region.snapshot).toMatchObject({ status: 'unauthorized', region: undefined });
    expect([...keptRegions(navigator, owner()).values()]).toEqual([{ status: 'unauthorized' }]);
  });

  it('a region status it does not know is an exception — nothing more than an error is shown', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = () => Response.json({ message: 'Later' }, { status: 500, headers: { [REGION_STATUS_HEADER]: 'a-status-of-a-later-release' } });
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/one');
    await region.load();
    expect(region.snapshot.status).toBe('exception');
  });

  it('a 409 (a new build) loads the whole page again — and drops every island kept in memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    let deployed = false;
    win.handler = (url) =>
      deployed ? new Response(null, { status: 409, headers: { [LOCATION_HEADER]: url } }) : islandResponse(island(new URL(url).pathname));
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    await navigator.use(islands).region('/islands/one').load();
    deployed = true;
    const two = navigator.use(islands).region('/islands/two');
    await two.load();
    // The page reloads — not the island's URL (the location header): an island has no page of its own.
    expect(win.loads).toEqual(['reload']);
    expect(two.snapshot.status).toBe('loading');
    expect(navigator.cachedPages).toBe(0);
    expect(owner().closed).toBe(true);
  });

  it('signing out (a visit answered 409) aborts islands under way — nothing of them lands, nothing stays in memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const slow = held();
    let aborted = false;
    win.handler = (url, init) => {
      if (url.endsWith('/logout')) return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
      init.signal?.addEventListener('abort', () => (aborted = true));
      return slow.response;
    };
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/activity');
    void region.load();
    await navigator.visit('/logout', { method: 'post' });
    expect(aborted).toBe(true);
    slow.release(islandResponse(island('/islands/activity', { private: true })));
    await settle();
    expect(region.snapshot.region).toBeUndefined();
    expect(keptRegions(navigator, owner()).size).toBe(0);
    expect(navigator.cachedPages).toBe(0);
    expect(win.loads).toEqual(['assign https://app.test/login']);
  });

  it('reload({ query }) loads only that island with the new query — defaults left out of its URL, merged lists started over', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url) => {
      const { pathname, search, searchParams } = new URL(url);
      const range = searchParams.get('range') ?? '30d';
      return islandResponse(
        island(pathname + search, { entries: [range] }, { query: Object.fromEntries(searchParams), queryDefaults: { range: '30d', limit: 5 }, mergeProps: ['entries'] }),
      );
    };
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/sign-ins');
    await region.load();
    expect(region.query).toEqual({ range: '30d', limit: 5 });

    await region.reload({ query: { range: '7d' } });
    expect(islandRequests(win).at(-1)?.url).toBe(`${ORIGIN}/islands/sign-ins?range=7d`);
    expect(region.snapshot.region?.props).toEqual({ entries: ['7d'] });
    expect(region.url).toBe('/islands/sign-ins?range=7d');

    // A partial reload with another query: the merge() list starts over (`reset` = `only`) instead of growing.
    await region.reload({ query: { range: undefined }, only: ['entries'] });
    expect(islandRequests(win).at(-1)).toMatchObject({
      url: `${ORIGIN}/islands/sign-ins`,
      headers: { [PARTIAL_COMPONENT_HEADER]: 'dashboard/RecentSignIns', [PARTIAL_DATA_HEADER]: 'entries' },
    });
    expect(region.snapshot.region?.props).toEqual({ entries: ['30d'] });
    // The same query again, partially: merged (a poll of a merge() list).
    await region.reload({ only: ['entries'] });
    expect(region.snapshot.region?.props).toEqual({ entries: ['30d', '30d'] });
    expect(win.requests.filter((request) => !request.headers[REGION_HEADER])).toEqual([]);
  });

  it('back on the entry, the island shows the query it was reloaded with — not the one it was embedded with', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url) => {
      if (!url.includes('/islands/')) return pageResponse(page('/people', {}, 'user-profile/People'));
      const { pathname, search, searchParams } = new URL(url);
      return islandResponse(island(pathname + search, {}, { query: Object.fromEntries(searchParams), queryDefaults: { range: '30d' } }));
    };
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/sign-ins?limit=5');
    await region.load();
    await region.reload({ query: { range: 'all' } });
    await navigator.visit('/people');
    win.back();
    await settle();
    const again = navigator.use(islands).region('/islands/sign-ins?limit=5', { owner: owner() });
    expect(again.query).toMatchObject({ range: 'all', limit: '5' });
    expect(regionId(again.url)).toBe('/islands/sign-ins?limit=5&range=all');
  });

  it('a partial reload of the page keeps its islands — no request; a pushed one of the same page takes a copy', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    win.handler = (url) =>
      url.includes('/islands/') ? islandResponse(island(new URL(url).pathname)) : pageResponse(page(new URL(url).pathname + new URL(url).search, { people: [] }, 'user-profile/People'));
    const { navigator, owners, owner } = boot(win, page('/people', { people: [] }, 'user-profile/People'));
    const first = owner();
    await navigator.use(islands).region('/islands/sign-ins').load();
    // Typing a filter: a partial reload replacing the entry, state kept → the same owner.
    await navigator.visit('/people?q=a', { only: ['people'], replace: true, preserveState: true });
    expect(owners.at(-1)).toBe(first);
    // A sort link: a new entry of the same page, state kept → its own owner, with a copy of the islands.
    await navigator.visit('/people?sort=-name', { only: ['people'], preserveState: true });
    expect(owner()).not.toBe(first);
    expect(navigator.use(islands).region('/islands/sign-ins', { owner: owner() }).snapshot.status).toBe('ready');
    expect(islandRequests(win)).toHaveLength(1);
    // Another page (state not kept) starts without islands.
    await navigator.visit('/people?sort=name');
    expect(keptRegions(navigator, owner()).size).toBe(0);
  });

  it('loads the deferred props of an island and merges them in', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    win.handler = (url, init) => {
      const partial = (init.headers as Record<string, string>)[PARTIAL_DATA_HEADER];
      return partial
        ? islandResponse(island('/islands/activity', { history: ['joined'] }))
        : islandResponse(island('/islands/activity', { now: 'now' }, { deferredProps: { default: ['history'] } }));
    };
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/activity');
    await region.load();
    await settle();
    expect(region.snapshot.region).toMatchObject({ props: { now: 'now', history: ['joined'] } });
    expect(region.snapshot.region?.deferredProps).toBeUndefined();
    expect(islandRequests(win).at(-1)?.headers).toMatchObject({ [PARTIAL_COMPONENT_HEADER]: 'dashboard/RecentSignIns', [PARTIAL_DATA_HEADER]: 'history' });
  });

  it('starts ready with a region object the server already sent (streamed with the page) — no request', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const { navigator, owner } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/sign-ins', { initial: island('/islands/sign-ins', { streamed: true }) });
    await region.load();
    expect(region.snapshot).toMatchObject({ status: 'ready', region: { props: { streamed: true } } });
    expect(keptRegions(navigator, owner()).has('/islands/sign-ins')).toBe(true);
    expect(win.requests).toEqual([]);
  });

  it('a prefetch of a page loads no island (the server does not know them)', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    win.handler = () => pageResponse(page('/dashboard', {}, 'dashboard/Show'));
    const { navigator } = boot(win, page('/people', {}, 'user-profile/People'));
    await navigator.use(prefetch).prefetch('/dashboard');
    expect(win.requests).toHaveLength(1);
    expect(islandRequests(win)).toEqual([]);
  });

  it('refuses a region of another site', () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    expect(() => navigator.use(islands).region('https://evil.example/islands/x')).toThrow(/from this site/);
  });
});

describe('Region — started with what the server streamed', () => {
  it('shows a streamed island at once and loads nothing — kept in the entry like a loaded one', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const { navigator, owner } = boot(win, page('/dashboard'));
    const result = { status: 'ready', region: island('/islands/sign-ins', { entries: ['ada'] }) } as const;
    const region = navigator.use(islands).region('/islands/sign-ins', { initial: regionInitial(result) });
    expect(region.snapshot).toMatchObject({ status: 'ready', region: { props: { entries: ['ada'] } }, pending: false });
    await region.load();
    expect(islandRequests(win)).toEqual([]);
    expect(keptRegions(navigator, owner()).get('/islands/sign-ins')).toEqual(result.region);
  });

  it('starts a refused island refused (no data), a failed one failed — shown, not kept: Back asks again', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const { navigator, owner } = boot(win, page('/dashboard'));
    const refused = navigator.use(islands).region('/islands/members', { initial: regionInitial({ status: 'forbidden' }) });
    expect(refused.snapshot.status).toBe('forbidden');
    const failed = navigator.use(islands).region('/islands/broken', { initial: regionInitial({ status: 'exception', failure: { status: 500 } }) });
    expect(failed.snapshot).toMatchObject({ status: 'exception', failure: { status: 500 } });
    await Promise.all([refused.load(), failed.load()]);
    expect(islandRequests(win)).toEqual([]);
    expect(keptRegions(navigator, owner()).get('/islands/members')).toEqual({ status: 'forbidden' });
    expect(keptRegions(navigator, owner()).has('/islands/broken')).toBe(false);
    // Left to the browser by the server: it loads itself.
    expect(regionInitial({ status: 'browser' })).toBeUndefined();
  });
});
