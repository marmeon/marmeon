import type { RouteManifest } from '@marmeon/http/page';
import { describe, expect, it } from 'vitest';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';
import { useQueryState } from './use-query-state.ts';

const routes: RouteManifest = {
  show: { method: 'get', path: '/users/:user' },
  home: { method: 'get', path: '/:locale/people', localized: true },
};

function Search({ name }: { name: string }) {
  const [query] = useQueryState(name);
  return <output>{String(query.q)}</output>;
}
const resolve = resolveModulePages({
  '/modules/app/views/Show.tsx': async () => ({ default: () => <Search name="show" /> }),
  '/modules/app/views/Home.tsx': async () => ({ default: () => <Search name="home" /> }),
  '/modules/app/views/Nowhere.tsx': async () => ({ default: () => <Search name="nowhere" /> }),
});

const render = async (component: string, url: string, manifest: RouteManifest | null = routes, extra: object = {}) => {
  const page = { component, props: {}, url, version: null, query: { q: 'al' }, queryDefaults: { q: '' }, ...extra };
  return new Response((await createSsrRenderer(resolve, { routes: manifest ?? undefined })(page)).html).text();
};

describe('useQueryState while the server renders', () => {
  it('renders the page of a route with a parameter', async () => {
    expect(await render('app/Show', '/users/7?q=al')).toContain('<output>al</output>');
  });

  it('renders the page of a localized route', async () => {
    expect(await render('app/Home', '/de/people?q=al', routes, { locale: 'de' })).toContain('<output>al</output>');
  });

  it('names a route the browser does not know', async () => {
    await expect(render('app/Nowhere', '/nowhere')).rejects.toThrow('[marmeon:C2] Route [nowhere]');
  });

  it('names the missing manifest', async () => {
    await expect(render('app/Show', '/users/7?q=al', null)).rejects.toThrow('[marmeon:C1] Route [show]');
  });
});
