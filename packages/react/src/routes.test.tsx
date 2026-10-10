import { resolveRoute } from '@marmeon/http/client';
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
      <Link href="/people/7/notes" method="post" data={{ title: 'Hi', stars: 5, draft: { body: 'x' } }}>
        Note
      </Link>
      <Link route="auth.logout" confirm="Sign out everywhere?">
        Sign out everywhere
      </Link>
      <Link href="https://example.com">elsewhere</Link>
      <Link href="https://elsewhere.example/hook" method="post">
        Elsewhere
      </Link>
      <Link href="//elsewhere.example/hook" method="post">
        Protocol-relative
      </Link>
      {/* What the URL parser reads as another origin, though no scheme or `//` starts it: it drops tabs and newlines, and leading spaces. */}
      <Link href={'/\t/elsewhere.example/hook'} method="post">
        Tab
      </Link>
      <Link href={'/\n/elsewhere.example/hook'} method="post">
        Newline
      </Link>
      <Link href=" //elsewhere.example/hook" method="post">
        Leading space
      </Link>
      <Link href={'/\\elsewhere.example/hook'} method="post">
        Backslash
      </Link>
      {/* The scheme of the page without `//`: relative to a page of the same scheme, another host to a page of the other. */}
      <Link href="http:elsewhere.example/hook" method="post">
        Scheme only
      </Link>
      <Link href="http:/elsewhere.example/hook" method="post">
        Scheme and one slash
      </Link>
      <Link href="HTTP:elsewhere.example/hook" method="post">
        Scheme in capitals
      </Link>
      <Link href=" https:elsewhere.example/hook" method="post">
        Scheme after a space
      </Link>
      <Link href={'http:\\elsewhere.example/hook'} method="post">
        Scheme and a backslash
      </Link>
      <Link href="?tab=links" method="post">
        Query
      </Link>
      <Link href="notes/1" method="post">
        Relative
      </Link>
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
    expect(html).toContain('<button type="submit">Sign out</button>');
    expect(html).toContain('<button type="submit">Remove</button>');
    expect(html).toContain('<a href="https://example.com">elsewhere</a>');
    expect(html).toContain('<p>/people/7?page=2</p>'); // extra parameters into the query, like Router.url()
    expect(html).toContain('<p>put<!-- --> <!-- -->/people/7</p>');
  });

  it('renders a link that sends as a real form, which works without JavaScript: POST, _method first, the token, flat data', async () => {
    const render = createSsrRenderer(resolve, { routes });
    const html = await new Response((await render({ component: 'people/Page', props: { id: 7 }, url: '/', version: null, csrf: 't0ken' })).html).text();
    const form = (action: string, fields: string, button: string) => `<form class="marmeon-link" action="${action}" method="post">${fields}${button}</form>`;
    const token = '<input type="hidden" name="_token" value="t0ken"/>';
    const forms = html.match(/<form class="marmeon-link"[\s\S]*?<\/form>|<button[^>]*>[^<]*<\/button>/g) ?? [];
    // The forms in full in the message: what a missing field or another button type looks like.
    expect(forms, JSON.stringify(forms)).toEqual([
      form('/logout', token, '<button type="submit">Sign out</button>'),
      // `_method` first: the server reads it at the start of the body only.
      form('/people/7/links/3', `<input type="hidden" name="_method" value="DELETE"/>${token}`, '<button type="submit">Remove</button>'),
      // Strings and numbers of `data` go along; an object needs JavaScript.
      form('/people/7/notes', `${token}<input type="hidden" name="title" value="Hi"/><input type="hidden" name="stars" value="5"/>`, '<button type="submit">Note</button>'),
      // A link that asks first never sends without asking: without JavaScript its button does nothing.
      form('/logout', token, '<button type="button">Sign out everywhere</button>'),
      // Another origin never gets the page's CSRF token, not even without JavaScript.
      form('https://elsewhere.example/hook', '', '<button type="submit">Elsewhere</button>'),
      form('//elsewhere.example/hook', '', '<button type="submit">Protocol-relative</button>'),
      form('/\t/elsewhere.example/hook', '', '<button type="submit">Tab</button>'),
      form('/\n/elsewhere.example/hook', '', '<button type="submit">Newline</button>'),
      form(' //elsewhere.example/hook', '', '<button type="submit">Leading space</button>'),
      form('/\\elsewhere.example/hook', '', '<button type="submit">Backslash</button>'),
      form('http:elsewhere.example/hook', '', '<button type="submit">Scheme only</button>'),
      form('http:/elsewhere.example/hook', '', '<button type="submit">Scheme and one slash</button>'),
      form('HTTP:elsewhere.example/hook', '', '<button type="submit">Scheme in capitals</button>'),
      form(' https:elsewhere.example/hook', '', '<button type="submit">Scheme after a space</button>'),
      form('http:\\elsewhere.example/hook', '', '<button type="submit">Scheme and a backslash</button>'),
      // This site's own relative hrefs keep the token.
      form('?tab=links', token, '<button type="submit">Query</button>'),
      form('notes/1', token, '<button type="submit">Relative</button>'),
    ]);
  });

  it('says what is missing: the manifest, or a route it does not carry', async () => {
    await expect(createSsrRenderer(resolve)({ component: 'people/Page', props: { id: 7 }, url: '/' })).rejects.toThrow(
      'the browser has no route manifest — pass the routes of virtual:marmeon/routes to createMarmeonApp({ routes })',
    );
    expect(() => resolveRoute(routes, 'admin.users')).toThrow(
      "Route [admin.users] is not defined in the browser: a build ships only the route names client code writes out (<Link route=\"…\">, route('…'), useForm('…', …)), never API routes, .internal() routes or clientRoutes.except",
    );
    expect(() => resolveRoute(routes, 'toString')).toThrow('Route [toString] is not defined'); // own keys only
    expect(() => resolveRoute(routes, 'people.show')).toThrow('Missing required parameter [person] for route [people.show].');
  });

  it('says the same with its code in production — only the code and the name (E80)', async () => {
    expect(() => resolveRoute(routes, 'admin.users')).toThrow(/^\[marmeon:C2\] Route \[admin\.users\] is not defined/);
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => resolveRoute(routes, 'admin.users')).toThrow(new Error('[marmeon:C2] admin.users'));
      expect(() => resolveRoute(undefined, 'people.show')).toThrow(new Error('[marmeon:C1] people.show'));
      await expect(resolveModulePages({})('users/Show')).rejects.toThrow(new Error('[marmeon:R2] users/Show'));
    } finally {
      process.env.NODE_ENV = environment;
    }
  });
});
