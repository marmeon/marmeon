import { describe, expect, it } from 'vitest';
import { ACTION_HEADER, ACTION_REDIRECT_HEADER, LOCATION_HEADER, PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, REGION_HEADER, type PageObject } from '../page.ts';
import { Navigator } from './navigation.ts';
import type { RegionOwner } from './region.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

/** A response the test lets through when it says so — to keep requests under way side by side. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const invalid = (errors: Record<string, string[]>) => json({ message: 'The given data was invalid.', errors }, 422);

type Link = { id: number; label: string };
const links = (...ids: number[]): Link[] => ids.map((id) => ({ id, label: `link ${id}` }));
const profile = (url = '/users/1', ...ids: number[]) => page(url, { profile: { name: 'Ada', links: links(...ids) }, activity: ['signed in'] }, 'user-profile/Show');
const linksOf = (shown: PageObject) => (shown.props as { profile: { links: Link[] } }).profile.links.map((link) => link.id);
const without = (id: number) => (props: Readonly<Record<string, unknown>>) => {
  const current = props.profile as { name: string; links: Link[] };
  return { profile: { ...current, links: current.links.filter((link) => link.id !== id) } };
};

describe('navigator.action — requests that do not navigate (E59)', () => {
  it('sends an action: its method, JSON body, the action header, never cached — and changes neither URL nor history', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    let init: RequestInit | undefined;
    win.handler = (_url, request) => {
      init = request;
      return json({ deleted: 2 });
    };
    const { navigator, shown } = boot(win, profile('/users/1', 1, 2));
    const entries = JSON.stringify(win.entries);

    const outcome = await navigator.action('/users/1/links/2', { method: 'delete' });

    expect(outcome).toEqual({ ok: true, kind: 'data', status: 200, data: { deleted: 2 } });
    expect(win.requests).toEqual([expect.objectContaining({ url: `${ORIGIN}/users/1/links/2`, method: 'DELETE', headers: expect.objectContaining({ [ACTION_HEADER]: 'true', accept: 'application/json', 'content-type': 'application/json' }) })]);
    expect(win.requests[0]!.headers[PAGE_HEADER]).toBeUndefined();
    expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
    // Counter-check: an action never pushes (or replaces) a history entry, and renders nothing by itself.
    expect(JSON.stringify(win.entries)).toBe(entries);
    expect(win.current.url).toBe(`${ORIGIN}/users/1`);
    expect(shown).toEqual([]);
  });

  it('reports a redirect without following it — and follows it only with onRedirect: "visit"', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => (url.endsWith('/links') ? new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/1' } }) : pageResponse(profile('/users/1', 1, 3)));
    const { navigator } = boot(win, profile('/users/1', 1));

    expect(await navigator.action('/users/1/links', { data: { label: 'x', url: 'https://x.test' } })).toEqual({ ok: true, kind: 'redirect', redirect: '/users/1' });
    expect(win.requests).toHaveLength(1);

    await navigator.action('/users/1/links', { data: {}, onRedirect: 'visit' });
    expect(win.requests.map((request) => request.headers[PAGE_HEADER])).toEqual([undefined, undefined, 'true']);
  });

  it('ends failures as outcomes, never as rejections: 422 → invalid, 401/419/5xx → exception, offline → network', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const { navigator } = boot(win, profile('/users/1', 1));
    win.handler = () => invalid({ label: ['The label is required.'] });
    expect(await navigator.action('/users/1/links', { data: {} })).toEqual({ ok: false, kind: 'invalid', errors: { label: ['The label is required.'] }, message: 'The given data was invalid.' });
    win.handler = () => json({ message: 'CSRF token mismatch.' }, 419);
    expect(await navigator.action('/users/1/links', { data: {} })).toEqual({ ok: false, kind: 'exception', exception: { type: 'server', status: 419, message: 'CSRF token mismatch.' } });
    win.handler = () => new Response('<h1>Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } });
    expect(await navigator.action('/users/1/links', { data: {} })).toEqual({ ok: false, kind: 'exception', exception: { type: 'server', status: 502, message: undefined } });
    win.handler = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await navigator.action('/users/1/links', { data: {} })).toMatchObject({ ok: false, kind: 'exception', exception: { type: 'network' } });
  });

  it('refuses another site: the XSRF token never leaves this one', async () => {
    const { navigator } = boot(new FakeWindow(`${ORIGIN}/users/1`), profile());
    await expect(navigator.action('https://evil.test/steal', { data: {} })).rejects.toThrow(/this site/);
  });
});

describe('optimistic patches (E59 model 1)', () => {
  it('shows a patch at once and, on a 422, restores exactly the props there were — the same object', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2));
    const before = navigator.page;

    const running = navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)) });
    await settle();
    expect(linksOf(visible())).toEqual([1]);
    // The props in memory are still the server's: the patch is only over them.
    expect(linksOf(navigator.page)).toEqual([1, 2]);

    answer.open(invalid({ link: ['This link cannot be removed.'] }));
    expect(await running).toMatchObject({ ok: false, kind: 'invalid' });
    expect(visible()).toBe(before);
    expect(visible().props).toEqual(before.props);
  });

  it('two actions on the same list, the first fails: only its patch goes — the second stays', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const first = gate<Response>();
    const second = gate<Response>();
    win.handler = (url) => (url.endsWith('/1') && !url.includes('/users/1/links/2') ? first.promise : second.promise);
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2, 3));

    const removeOne = navigator.action('/users/1/links/1', { method: 'delete', optimistic: navigator.optimistic(without(1)) });
    const removeTwo = navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)) });
    await settle();
    expect(linksOf(visible())).toEqual([3]);

    first.open(json({ message: 'Not found.' }, 404));
    await removeOne;
    expect(linksOf(visible())).toEqual([1, 3]);

    second.open(json({ deleted: 2 }));
    await removeTwo;
    // Succeeded without a reload: what its patch shows is the state now — in memory too.
    expect(linksOf(visible())).toEqual([1, 3]);
    expect(linksOf(navigator.page)).toEqual([1, 3]);
  });

  it('two actions on the same list, both reload: the patches go as the server props land — an older answer never lands last', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const deletes = [gate<Response>(), gate<Response>()];
    const reloads: { url: string; headers: Record<string, string>; answer: ReturnType<typeof gate<Response>> }[] = [];
    win.handler = (url, init) => {
      if (init.method === 'DELETE') return deletes[url.endsWith('/1') ? 0 : 1]!.promise;
      const answer = gate<Response>();
      reloads.push({ url, headers: init.headers as Record<string, string>, answer });
      return answer.promise;
    };
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2, 3));

    const removeOne = navigator.action('/users/1/links/1', { method: 'delete', optimistic: navigator.optimistic(without(1)), reload: navigator.reloading({ only: ['profile'] }) });
    const removeTwo = navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)), reload: navigator.reloading({ only: ['profile'] }) });
    await settle();
    deletes[0]!.open(json({ deleted: 1 }));
    await settle();
    // The first reload asks for the profile only — a partial reload of the page on screen.
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.headers).toMatchObject({ [PAGE_HEADER]: 'true', [PARTIAL_COMPONENT_HEADER]: 'user-profile/Show', [PARTIAL_DATA_HEADER]: 'profile' });
    deletes[1]!.open(json({ deleted: 2 }));
    await settle();
    // The second one replaced it (the first was aborted): it takes both patches over.
    expect(reloads).toHaveLength(2);
    expect(linksOf(visible())).toEqual([3]);

    // The newer answer lands first; the first, older one — read before the second delete — would still show link 2: it must
    // land nowhere (aborted), or link 2 would come back once the patches are gone.
    reloads[1]!.answer.open(pageResponse({ ...profile('/users/1', 3), props: { profile: { name: 'Ada', links: links(3) } } }));
    await settle();
    reloads[0]!.answer.open(pageResponse({ ...profile('/users/1', 2, 3), props: { profile: { name: 'Ada', links: links(2, 3) } } }));
    await Promise.all([removeOne, removeTwo]);
    await settle();
    expect(linksOf(visible())).toEqual([3]);
    expect(linksOf(navigator.page)).toEqual([3]);
    // Merged in: the other props stay.
    expect(navigator.page.props.activity).toEqual(['signed in']);
  });

  it('a network failure rolls back and says so', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => Promise.reject(new TypeError('Failed to fetch'));
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2));
    const outcome = await navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)) });
    expect(outcome).toMatchObject({ kind: 'exception', exception: { type: 'network' } });
    expect(linksOf(visible())).toEqual([1, 2]);
  });

  it('no patch survives in the page cache after a rollback: Back then Forward shows the server props', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = (url, init) => (init.method === 'DELETE' ? answer.promise : pageResponse(page('/people', {}, 'user-profile/People')));
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2));

    const running = navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)) });
    await settle();
    expect(linksOf(visible())).toEqual([1]);
    // Away while it is under way — then it fails.
    await navigator.visit('/people');
    answer.open(json({ message: 'Forbidden.' }, 403));
    await running;

    const requests = win.requests.length;
    win.back();
    await settle();
    expect(linksOf(visible())).toEqual([1, 2]);
    win.forward();
    await settle();
    win.back();
    await settle();
    expect(linksOf(visible())).toEqual([1, 2]);
    expect(win.requests.length).toBe(requests); // from memory — the server's props, nothing of the patch
    for (const { state } of win.entries) expect(state).not.toContain('link');
  });

  it('after signing out (another tab), the action is a 401: its patch goes, it is not tried again', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => json({ message: 'Unauthenticated.' }, 401);
    const { navigator, visible } = boot(win, profile('/users/1', 1, 2));
    const outcome = await navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)), reload: navigator.reloading({ only: ['profile'] }) });
    expect(outcome).toEqual({ ok: false, kind: 'exception', exception: { type: 'server', status: 401, message: 'Unauthenticated.' } });
    expect(linksOf(visible())).toEqual([1, 2]);
    await settle();
    expect(win.requests).toHaveLength(1);
  });

  it('signed out in this tab while it runs (a 409 elsewhere): nothing of it lands — no patch, no reload', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = (url, init) => (init.method === 'DELETE' ? answer.promise : new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } }));
    const { navigator, shown } = boot(win, profile('/users/1', 1, 2));
    const running = navigator.action('/users/1/links/2', { method: 'delete', optimistic: navigator.optimistic(without(2)), reload: navigator.reloading({ only: ['profile'] }) });
    await settle();
    // Signing out: the document is left for /login.
    await navigator.visit('/logout', { method: 'post' });
    expect(win.loads).toEqual(['assign /login']);
    const renders = shown.length;
    answer.open(json({ deleted: 2 }));
    expect(await running).toEqual({ ok: false, kind: 'cancelled' });
    await settle();
    // Nothing lands: no render, no reload, no state in memory (it went with the document).
    expect(shown.length).toBe(renders);
    expect(win.requests.filter((request) => request.method === 'GET')).toEqual([]);
    expect(navigator.submissions).toEqual([]);
    expect(navigator.cachedPages).toBe(0);
    expect(linksOf(navigator.page)).toEqual([1, 2]);
  });

  it('an action that signs out (a 409 with a location) loads that page fully — memory goes with the document', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
    const { navigator } = boot(win, profile('/users/1', 1));
    expect(await navigator.action('/logout')).toEqual({ ok: false, kind: 'cancelled' });
    expect(win.loads).toEqual(['assign /login']);
    expect(navigator.cachedPages).toBe(0);
  });

  it('a newer action with the same key cancels the older — its patch with it', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answers = [gate<Response>(), gate<Response>()];
    let call = 0;
    win.handler = (_url, init) =>
      new Promise((resolve, reject) => {
        const answer = answers[call++]!;
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        void answer.promise.then(resolve);
      });
    const { navigator, visible } = boot(win, page('/posts/1', { liked: false, likes: 1 }, 'posts/Show'));
    const like = (liked: boolean) => navigator.action('/posts/1/like', { data: { liked }, key: 'like', optimistic: navigator.optimistic((props) => ({ liked, likes: (props.likes as number) + (liked ? 1 : -1) })) });

    const first = like(true);
    await settle();
    const second = like(false);
    expect(await first).toEqual({ ok: false, kind: 'cancelled' });
    expect(visible().props).toEqual({ liked: false, likes: 0 });
    answers[1]!.open(json({ liked: false }));
    expect(await second).toMatchObject({ ok: true, kind: 'data' });
  });

  it('patches the layer on screen — its view, never its props in memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = (_url, init) => (init.method === 'DELETE' ? answer.promise : pageResponse({ ...page('/users/1/edit', { profile: { name: 'Ada', links: links(1, 2) } }, 'user-profile/Edit'), layer: { key: 'edit', base: '/users/1' } }));
    const { navigator } = boot(win, profile('/users/1', 1, 2));
    await navigator.visit('/users/1/edit', { layer: true });
    const layer = navigator.layers[0]!;

    const running = navigator.action('/users/1/links/2', { method: 'delete', optimistic: layer.optimistic(without(2)) });
    await settle();
    expect(linksOf(layer.view)).toEqual([1]);
    expect(linksOf(layer.page)).toEqual([1, 2]);
    expect(linksOf(navigator.page)).toEqual([1, 2]); // the page beneath is not touched
    answer.open(json({ message: 'Server Error' }, 500));
    await running;
    expect(layer.view).toBe(layer.page);
  });

  it('patches an island — and reloads it after the action, the patch going with the answer', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const answer = gate<Response>();
    const islandAnswer = (ids: number[]) =>
      new Response(JSON.stringify({ component: 'dashboard/Links', props: { links: links(...ids) }, url: '/dashboard/links', version: null }), {
        headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', 'content-type': 'application/json' },
      });
    let islandRequests = 0;
    win.handler = (url, init) => {
      if (init.method === 'DELETE') return answer.promise;
      islandRequests++;
      return islandRequests === 1 ? islandAnswer([1, 2]) : islandAnswer([1]);
    };
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.region('/dashboard/links');
    await region.load();

    const running = navigator.action('/links/2', { method: 'delete', optimistic: region.optimistic(without2Links), reload: region.reloading({ only: ['links'] }) });
    await settle();
    expect(idsOf(region.snapshot.region!.props)).toEqual([1]);
    answer.open(json({ deleted: 2 }));
    await running;
    expect(islandRequests).toBe(2);
    expect(idsOf(region.snapshot.region!.props)).toEqual([1]);
    expect(navigator.regionOwner.regions.get(region.id)).toMatchObject({ props: { links: links(1) } });
  });

  it('a form visit with a patch (useForm({ optimistic })): shown while under way, then the answer — or rolled back', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    const { navigator, visible, shown } = boot(win, profile('/users/1', 1));
    const visiting = navigator.visit('/users/1/links', { method: 'post', data: { label: 'new' }, optimistic: navigator.optimistic((props) => ({ profile: { ...(props.profile as object), links: [...links(1), { id: -1, label: 'new' }] } })) });
    await settle();
    expect(linksOf(visible())).toEqual([1, -1]);
    answer.open(pageResponse(profile('/users/1', 1, 7)));
    await visiting;
    expect(linksOf(visible())).toEqual([1, 7]);
    // The answer rendered without the patch: no frame with both the ghost and the real link.
    expect(shown.map(linksOf)).toEqual([[1, -1], [1, 7]]);
  });
});

function without2Links(props: Readonly<Record<string, unknown>>) {
  return { links: (props.links as Link[]).filter((link) => link.id !== 2) };
}

function idsOf(props: Readonly<Record<string, unknown>>) {
  return (props.links as Link[]).map((link) => link.id);
}

describe('submissions — ghost rows (E59 model 2)', () => {
  it('lists an action with its input while under way — until the props it reloads have landed', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const post = gate<Response>();
    const reload = gate<Response>();
    win.handler = (_url, init) => (init.method === 'POST' ? post.promise : reload.promise);
    const { navigator, visible } = boot(win, profile('/users/1', 1));
    const changes: number[] = [];
    navigator.subscribeSubmissions(() => changes.push(navigator.submissions.length));

    const running = navigator.action('/users/1/links', { data: { label: 'Blog', url: 'https://blog.test' }, name: 'user-profile.links.store', reload: navigator.reloading({ only: ['profile'] }) });
    expect(navigator.submissions).toEqual([{ id: expect.any(Number), name: 'user-profile.links.store', method: 'post', url: '/users/1/links', input: { label: 'Blog', url: 'https://blog.test' } }]);
    post.open(new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/1' } }));
    await settle();
    expect(navigator.submissions).toHaveLength(1); // still: the real row is not there yet
    reload.open(pageResponse(profile('/users/1', 1, 2)));
    await running;
    expect(navigator.submissions).toEqual([]);
    expect(linksOf(visible())).toEqual([1, 2]);
    expect(changes).toEqual([1, 0]);
  });

  it('lists a route form while it is sent (a visit with a name)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    const { navigator } = boot(win, profile('/users/1', 1));
    const visiting = navigator.visit('/users/1/links', { method: 'post', data: { label: 'x' }, name: 'user-profile.links.store' });
    expect(navigator.submissions.map((submission) => submission.name)).toEqual(['user-profile.links.store']);
    answer.open(pageResponse(profile('/users/1', 1)));
    await visiting;
    expect(navigator.submissions).toEqual([]);
  });
});

describe('revalidateOnBack (E58)', () => {
  function app(declared: Record<string, boolean | readonly string[] | undefined>) {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const shown: PageObject[] = [];
    win.handler = (url, init) => {
      const headers = init.headers as Record<string, string>;
      if (url.endsWith('/people')) return pageResponse(page('/people', {}, 'user-profile/People'));
      if (headers[PARTIAL_DATA_HEADER]) return pageResponse({ ...profile('/users/1', 1), props: { activity: ['fresh'] } });
      return pageResponse({ ...profile('/users/1', 1), props: { ...profile('/users/1', 1).props, activity: ['all fresh'] } });
    };
    const navigator = new Navigator({
      initialPage: profile('/users/1', 1),
      window: win,
      render: async (next) => void shown.push(next),
      revalidateOnBack: (component) => declared[component],
    });
    navigator.start();
    return { win, navigator, visible: () => shown.at(-1)! };
  }

  it('shows the page from memory at once, then reloads only the declared props in the background', async () => {
    const { win, navigator, visible } = app({ 'user-profile/Show': ['activity'] });
    await navigator.visit('/people');
    const requests = win.requests.length;
    win.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(visible().props.activity).toEqual(['signed in']); // from memory, at once
    await settle();
    await settle();
    expect(win.requests.slice(requests)).toEqual([
      expect.objectContaining({ url: `${ORIGIN}/users/1`, method: 'GET', headers: expect.objectContaining({ [PARTIAL_COMPONENT_HEADER]: 'user-profile/Show', [PARTIAL_DATA_HEADER]: 'activity' }) }),
    ]);
    expect(visible().props.activity).toEqual(['fresh']);
    expect(visible().props.profile).toEqual(profile('/users/1', 1).props.profile);
  });

  it('counter-check: a view that declares nothing makes no request on Back', async () => {
    const { win, navigator } = app({});
    await navigator.visit('/people');
    const requests = win.requests.length;
    win.back();
    await settle();
    await settle();
    expect(win.requests.length).toBe(requests);
  });

  it('true reloads every prop of the page — and never for the first load or a fresh visit', async () => {
    const { win, navigator, visible } = app({ 'user-profile/Show': true });
    await settle();
    expect(win.requests).toEqual([]);
    await navigator.visit('/people');
    win.back();
    await settle();
    await settle();
    expect(win.requests.at(-1)!.headers[PARTIAL_DATA_HEADER]).toBeUndefined();
    expect(visible().props.activity).toEqual(['all fresh']);
  });
});

describe('revalidateOnBack for layers and islands (E58)', () => {
  it('a layer Forward opens again from memory reloads what its view declares — as the layer', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const edit = (name: string) => ({ ...page('/users/1/edit', { profile: { name } }, 'user-profile/Edit'), layer: { key: 'edit', base: '/users/1' } });
    let fresh = false;
    win.handler = () => pageResponse(edit(fresh ? 'Ada Lovelace' : 'Ada'));
    const shown: PageObject[] = [];
    const navigator = new Navigator({
      initialPage: profile('/users/1', 1),
      window: win,
      render: async (next) => void shown.push(next),
      revalidateOnBack: (component) => (component === 'user-profile/Edit' ? ['profile'] : undefined),
    });
    navigator.start();
    await navigator.visit('/users/1/edit', { layer: true });
    win.back();
    await settle();
    expect(navigator.layers).toEqual([]);
    const requests = win.requests.length;
    fresh = true;
    win.forward();
    await settle();
    await settle();
    expect(win.requests.slice(requests)).toEqual([
      expect.objectContaining({ headers: expect.objectContaining({ [REGION_HEADER]: 'layer', [PARTIAL_COMPONENT_HEADER]: 'user-profile/Edit', [PARTIAL_DATA_HEADER]: 'profile' }) }),
    ]);
    expect(navigator.layers[0]!.page.props).toEqual({ profile: { name: 'Ada Lovelace' } });
  });

  it('an island shown from memory by Back reloads what its view declares — once, when it is shown', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    let count = 1;
    win.handler = (url, init) => {
      if (url.endsWith('/people')) return pageResponse(page('/people', {}, 'user-profile/People'));
      const partial = (init.headers as Record<string, string>)[PARTIAL_DATA_HEADER];
      return new Response(JSON.stringify({ component: 'dashboard/MyActivity', props: partial ? { entries: count++ } : { entries: count++, since: 'today' }, url: '/dashboard/activity', version: null }), {
        headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', 'content-type': 'application/json' },
      });
    };
    const owners: RegionOwner[] = [];
    const navigator = new Navigator({
      initialPage: page('/dashboard', {}, 'dashboard/Show'),
      window: win,
      render: async (_next, { owner }) => void owners.push(owner),
      revalidateOnBack: (component) => (component === 'dashboard/MyActivity' ? ['entries'] : undefined),
    });
    navigator.start();
    await navigator.region('/dashboard/activity').load();
    await navigator.visit('/people');
    win.back();
    await settle();
    const requests = win.requests.length;
    // The adapter renders the island again: from memory, then the declared props.
    const region = navigator.region('/dashboard/activity', { owner: owners.at(-1)! });
    expect(region.snapshot.region?.props).toEqual({ entries: 1, since: 'today' });
    await region.load();
    await settle();
    expect(win.requests.slice(requests)).toEqual([expect.objectContaining({ headers: expect.objectContaining({ [PARTIAL_DATA_HEADER]: 'entries' }) })]);
    expect(region.snapshot.region?.props).toEqual({ entries: 2, since: 'today' });
    // Once: shown again on the same entry, nothing more.
    await region.load();
    await settle();
    expect(win.requests.length).toBe(requests + 1);
  });
});
