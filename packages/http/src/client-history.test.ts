import type { HttpContext } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { cacheControl, ClearClientHistory, ClientHistory } from './client-history.ts';
import { LOCATION_HEADER, PAGE_HEADER } from './page.ts';

const ctx = (method: string, path: string, headers: Record<string, string> = {}) =>
  ({ request: new Request(`http://app.test${path}`, { method, headers }) }) as unknown as HttpContext;
const visit = { [PAGE_HEADER]: 'true' };
const run = (history: ClientHistory, context: HttpContext, response: Response) => new ClearClientHistory(history).handle(context, async () => response);

describe('ClientHistory / ClearClientHistory', () => {
  it('leaves responses alone until the history is cleared', async () => {
    const response = Response.redirect('http://app.test/home', 303);
    expect(await run(new ClientHistory(), ctx('POST', '/login', visit), response)).toBe(response);
  });

  it('turns the redirect of a client-side visit into 409 + x-marmeon-location (a full page load)', async () => {
    const history = new ClientHistory();
    history.clear();
    const response = await run(history, ctx('POST', '/login', visit), new Response(null, { status: 303, headers: { location: '/users/me', 'x-custom': 'kept' } }));
    expect(response.status).toBe(409);
    expect(response.headers.get(LOCATION_HEADER)).toBe('/users/me');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-custom')).toBe('kept');
    expect(response.headers.get('clear-site-data')).toBeNull();
  });

  it('reloads the requested page when the visit was answered with a page, not a redirect', async () => {
    const history = new ClientHistory();
    history.clear();
    const page = Response.json({ component: 'x', props: {}, url: '/a' }, { headers: { [PAGE_HEADER]: 'true' } });
    const response = await run(history, ctx('GET', '/a?tab=1', visit), page);
    expect([response.status, response.headers.get(LOCATION_HEADER), response.headers.get(PAGE_HEADER)]).toEqual([409, '/a?tab=1', null]);
  });

  it('keeps a plain browser request as it is — with Clear-Site-Data when asked for', async () => {
    const history = new ClientHistory();
    history.clear({ siteData: true });
    const response = await run(history, ctx('POST', '/logout'), new Response(null, { status: 303, headers: { location: '/login' } }));
    expect([response.status, response.headers.get('location'), response.headers.get('clear-site-data')]).toEqual([303, '/login', '"cache", "storage"']);
  });

  it('Clear-Site-Data names what was asked for — the cache alone, or nothing when a later call takes it back (the last call wins)', async () => {
    const cacheOnly = new ClientHistory();
    cacheOnly.clear({ siteData: ['cache'] });
    expect((await run(cacheOnly, ctx('POST', '/locale'), new Response(null, { status: 303, headers: { location: '/' } }))).headers.get('clear-site-data')).toBe('"cache"');
    const takenBack = new ClientHistory();
    takenBack.clear({ siteData: true });
    takenBack.clear({ siteData: false });
    expect((await run(takenBack, ctx('POST', '/logout'), new Response(null, { status: 303, headers: { location: '/login' } }))).headers.get('clear-site-data')).toBeNull();
    // A later call without the option keeps what the earlier one asked for.
    const kept = new ClientHistory();
    kept.clear({ siteData: true });
    kept.clear();
    expect(kept.siteData).toEqual(['cache', 'storage']);
  });
});

describe('cacheControl()', () => {
  it('sets Cache-Control unless the response has its own', async () => {
    const Middleware = cacheControl('private, max-age=60');
    const set = await new Middleware().handle(ctx('GET', '/'), async () => new Response('x'));
    expect(set.headers.get('cache-control')).toBe('private, max-age=60');
    const own = await new Middleware().handle(ctx('GET', '/'), async () => new Response('x', { headers: { 'cache-control': 'no-cache' } }));
    expect(own.headers.get('cache-control')).toBe('no-cache');
  });
});
