import { describe, expect, it } from 'vitest';
import { Form } from './form.tsx';
import { Island } from './island.tsx';
import { useAlternates } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages } from './pages.ts';
import { useRoute } from './routes.ts';
import { createSsrRenderer } from './server.tsx';
import { useForm } from './use-form.ts';

// Packages compile without an app's generated `Routes`: names are plain strings here, the types are tested in the web app.
const routes = {
  'about.index': { method: 'get', path: '/:locale/about', localized: true },
  'about.feature': { method: 'get', path: '/:locale/about/:feature', localized: true },
  'about.search': { method: 'post', path: '/:locale/about/search', localized: true },
  'about.teaser': { method: 'get', path: '/:locale/about/teaser', localized: true },
  'people.show': { method: 'get', path: '/people/:person' },
} as const;

function Page() {
  const route = useRoute();
  const form = useForm('about.search', { q: '' });
  return (
    <>
      <Link route="about.index">Own language</Link>
      <Link route="about.feature" params={{ feature: 'routes' }} query={{ tab: 'one' }}>Feature</Link>
      <Link route="about.index" params={{ locale: 'en' }}>English</Link>
      <Link route="about.index" params={{ locale: '//evil.example' }}>Evil</Link>
      <Link route="people.show" params={{ person: 7 }}>Not localized</Link>
      <Form route="about.search">
        <button type="submit">Search</button>
      </Form>
      <p id="route">{route('about.index')}</p>
      <p id="given">{route('about.index', { locale: 'en' })}</p>
      <p id="plain">{route('people.show', { person: 7 })}</p>
      <p id="form">{form.url}</p>
    </>
  );
}

function WithIsland() {
  return <Island route="about.teaser" />;
}

function Switcher() {
  return <p id="alternates">{JSON.stringify(useAlternates())}</p>;
}

const resolve = resolveModulePages({ '/modules/about/views/Page.tsx': async () => ({ default: Page }), '/modules/about/views/WithIsland.tsx': async () => ({ default: WithIsland }), '/modules/about/views/Switcher.tsx': async () => ({ default: Switcher }) });

async function render(page: { locale?: string; alternates?: Record<string, string> }, component = 'about/Page') {
  const html = await new Response((await createSsrRenderer(resolve, { routes })({ component, props: {}, url: '/de/about', ...page })).html).text();
  return html;
}

describe('the locale of the page in links, route() and forms', () => {
  it('fills the locale of the page in where a localized route is given none', async () => {
    const html = await render({ locale: 'de' });
    expect(html).toContain('<a href="/de/about" aria-current="page" data-current="">Own language</a>');
    expect(html).toContain('<a href="/de/about/routes?tab=one">Feature</a>');
    expect(html).toContain('<p id="route">/de/about</p>');
    expect(html).toContain('<p id="form">/de/about/search</p>');
    expect(html).toContain('action="/de/about/search"');
  });

  it('lets a locale of its own win', async () => {
    const html = await render({ locale: 'de' });
    expect(html).toContain('<a href="/en/about">English</a>');
    expect(html).toContain('<p id="given">/en/about</p>');
  });

  it('leaves a route that is not localized as it is', async () => {
    const html = await render({ locale: 'de' });
    expect(html).toContain('<a href="/people/7">Not localized</a>');
    expect(html).toContain('<p id="plain">/people/7</p>');
  });

  it('encodes a locale that is no language into one path segment of this site', async () => {
    const html = await render({ locale: 'de' });
    expect(html).toContain('<a href="/%2F%2Fevil.example/about">Evil</a>');
    expect(html).not.toContain('href="//');
  });
});

describe('useAlternates', () => {
  it('is empty on a page that is not localized', async () => {
    expect(await render({}, 'about/Switcher')).toContain('<p id="alternates">[]</p>');
  });

  it('lists the languages of the page, the current one marked, without x-default', async () => {
    const html = await render({ locale: 'de', alternates: { en: '/en/about?tab=one', de: '/de/about?tab=one', 'x-default': '/about?tab=one' } }, 'about/Switcher');
    const list = /<p id="alternates">(.*?)<\/p>/.exec(html)![1]!.replaceAll('&quot;', '"');
    expect(JSON.parse(list)).toEqual([
      { locale: 'en', url: '/en/about?tab=one', current: false },
      { locale: 'de', url: '/de/about?tab=one', current: true },
    ]);
  });
});

describe('islands', () => {
  it('ask for the page in the language of the page', async () => {
    const asked: string[] = [];
    const result = await createSsrRenderer(resolve, { routes })(
      { component: 'about/WithIsland', props: {}, url: '/de/about', locale: 'de' },
      { complete: true, resolveIsland: async (url: string) => (asked.push(url), { status: 'browser' as const }) },
    );
    await new Response(result.html).text();
    expect(asked).toEqual(['/de/about/teaser']);
  });
});
