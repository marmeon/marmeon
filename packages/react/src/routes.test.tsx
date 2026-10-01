import { resolveRoute } from '@bespokecore/http/client';
import { describe, expect, it } from 'vitest';
import { Link } from './link.tsx';
import { resolveModulePages } from './pages.ts';
import { useRoute } from './routes.ts';
import { createSsrRenderer } from './server.tsx';
import { useForm } from './use-form.ts';

// Packages compile without an app's generated `Routes`: names are plain strings here, the types are tested in the web app.
const routes = {
  'people.show': { method: 'get', path: '/people/:person' },
  'people.links.destroy': { method: 'delete', path: '/people/:person/links/:link' },
  'auth.logout': { method: 'post', path: '/logout' },
  'people.update': { method: 'put', path: '/people/:person' },
} as const;

function Page({ id }: { id: number }) {
  const route = useRoute();
  const form = useForm('people.update', { person: id }, { name: 'Ada' });
  return (
    <>
      <Link route="people.show" params={{ person: id }} query={{ tab: 'links' }}>
        Ada
      </Link>
      <Link route="auth.logout">Sign out</Link>
      <Link route="people.links.destroy" params={{ person: id, link: 3 }}>
        Remove
      </Link>
      <Link href="https://example.com">elsewhere</Link>
      <p>{route('people.show', { person: id, page: 2 })}</p>
      <p>
        {form.method} {form.url}
      </p>
    </>
  );
}

const resolve = resolveModulePages({ '../modules/people/views/Page.tsx': async () => ({ default: Page }) });

describe('routes in the browser', () => {
  it('renders links, buttons, URLs and forms from the route manifest — the same on the server', async () => {
    const render = createSsrRenderer(resolve, { routes });
    const html = await new Response((await render({ component: 'people/Page', props: { id: 7 }, url: '/' })).html).text();
    expect(html).toContain('<a href="/people/7?tab=links">Ada</a>');
    // Not GET: a button (actions are not links), its method from the route.
    expect(html).toContain('<button type="button">Sign out</button>');
    expect(html).toContain('<button type="button">Remove</button>');
    expect(html).toContain('<a href="https://example.com">elsewhere</a>');
    expect(html).toContain('<p>/people/7?page=2</p>'); // extra parameters into the query, like Router.url()
    expect(html).toContain('<p>put<!-- --> <!-- -->/people/7</p>');
  });

  it('says what is missing: the manifest, or a route it does not carry', async () => {
    await expect(createSsrRenderer(resolve)({ component: 'people/Page', props: { id: 7 }, url: '/' })).rejects.toThrow(
      'the browser has no route manifest — pass the routes of virtual:bespoke/routes to createBespokeApp({ routes })',
    );
    expect(() => resolveRoute(routes, 'admin.users')).toThrow(
      "Route [admin.users] is not defined in the browser: a build ships only the route names client code writes out (<Link route=\"…\">, route('…'), useForm('…', …)), never API routes, .internal() routes or clientRoutes.except",
    );
    expect(() => resolveRoute(routes, 'toString')).toThrow('Route [toString] is not defined'); // own keys only
    expect(() => resolveRoute(routes, 'people.show')).toThrow('Missing required parameter [person] for route [people.show].');
  });
});
