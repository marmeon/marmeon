import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { usePage } from './app.tsx';
import { Head } from './head.tsx';
import { resolveModulePages } from './pages.ts';
import { Pagination, pagesAround } from './pagination.tsx';
import { createSsrRenderer } from './server.tsx';

function Greeting({ name }: { name: string }) {
  const { url } = usePage();
  return <p>Hello {name} at {url}</p>;
}

function Titled({ name }: { name: string }) {
  return (
    <>
      <Head title="Layout" />
      <Head title={`${name} <admin>`}>
        <meta name="description" content={`Profile of ${name}`} />
      </Head>
      <p>{name}</p>
    </>
  );
}

const resolve = resolveModulePages({
  '../modules/greeting/views/Titled.tsx': async () => ({ default: Titled }),
  '../modules/greeting/views/Hello.tsx': async () => ({ default: Greeting }),
  '../modules/broken/views/NoDefault.tsx': async () => ({}),
  '../elsewhere/Ignored.tsx': async () => ({ default: Greeting }),
  '../modules/people/views/List.tsx': async () => ({ default: ({ page, lastPage }: { page: number; lastPage: number }) => <Pagination meta={{ page, perPage: 5, total: lastPage * 5, lastPage, from: 1, to: 5 }} /> }),
});

describe('resolveModulePages', () => {
  it('maps modules/<module>/views/<Page> to <module>/<Page>', async () => {
    expect(await resolve('greeting/Hello')).toBe(Greeting);
  });

  it('explains where a missing page is expected', async () => {
    await expect(resolve('greeting/Nope')).rejects.toThrow('modules/greeting/views/Nope.tsx');
    await expect(resolve('Ignored')).rejects.toThrow(/not found/);
    await expect(resolve('broken/NoDefault')).rejects.toThrow(/no default export/);
  });
});

describe('createSsrRenderer', () => {
  it('renders the page component with its props and page context', async () => {
    const render = createSsrRenderer(resolve);
    const { html } = await render({ component: 'greeting/Hello', props: { name: 'Ada' }, url: '/hi' });
    expect(html).toBe('<p>Hello <!-- -->Ada<!-- --> at <!-- -->/hi</p>');
  });
});

describe('<Head> on the server', () => {
  it('collects title (through the template, escaped, the last one wins) and tags for the document head', async () => {
    const render = createSsrRenderer(resolve, { title: (title) => `${title} — Shop` });
    const { html, head } = await render({ component: 'greeting/Titled', props: { name: 'Ada' }, url: '/ada' });
    expect(html).toBe('<p>Ada</p>');
    expect(head).toBe(
      '<title data-bespoke-head="ssr">Ada &#60;admin&#62; — Shop</title><meta name="description" content="Profile of Ada" data-bespoke-head="ssr"/>',
    );
  });

  it('adds nothing for pages without <Head>', async () => {
    const { head } = await createSsrRenderer(resolve)({ component: 'greeting/Hello', props: { name: 'Ada' }, url: '/' });
    expect(head).toBe('');
  });

  it('gives pages without <Head title> the default title — the same the browser falls back to', async () => {
    const { head } = await createSsrRenderer(resolve, { title: (title) => (title ? `${title} — Shop` : 'Shop') })({ component: 'greeting/Hello', props: { name: 'Ada' }, url: '/' });
    expect(head).toBe('<title data-bespoke-head="ssr">Shop</title>');
  });
});

describe('layouts on the server', () => {
  function Shell({ children }: { children: ReactNode }) {
    return <div className="shell">{children}</div>;
  }
  function Inner({ children }: { children: ReactNode }) {
    return <section>{children}</section>;
  }
  function Own() {
    return <p>own</p>;
  }
  Own.layout = [Shell, Inner];
  const withLayouts = resolveModulePages({
    '../modules/app/views/Hello.tsx': async () => ({ default: Greeting }),
    '../modules/app/views/Own.tsx': async () => ({ default: Own }),
    '../modules/app/views/Broken.tsx': async () => ({ default: Object.assign(() => null, { layout: 'Shell' }) }),
  });

  it('renders the page inside its layouts — its own, else the default', async () => {
    const render = createSsrRenderer(withLayouts, { layout: () => Shell });
    expect((await render({ component: 'app/Hello', props: { name: 'Ada' }, url: '/' })).html).toBe('<div class="shell"><p>Hello <!-- -->Ada<!-- --> at <!-- -->/</p></div>');
    expect((await render({ component: 'app/Own', props: {}, url: '/' })).html).toBe('<div class="shell"><section><p>own</p></section></div>');
  });

  it('refuses a layout that is not a component', async () => {
    await expect(withLayouts('app/Broken')).rejects.toThrow('Page [app/Broken] has an invalid layout: expected a component (or a list of them), got Shell.');
  });
});

describe('<Pagination>', () => {
  it('links the pages around the current one — keeping the rest of the query string', async () => {
    const { html } = await createSsrRenderer(resolve)({ component: 'people/List', props: { page: 6, lastPage: 20 }, url: '/people?q=ada&page=6' });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
    expect(hrefs).toEqual(['/people?q=ada&page=5', '/people?q=ada', '/people?q=ada&page=4', '/people?q=ada&page=5', '/people?q=ada&page=7', '/people?q=ada&page=8', '/people?q=ada&page=20', '/people?q=ada&page=7']);
    expect(html).toContain('<strong aria-current="page"> <!-- -->6<!-- --> </strong>');
    expect(html).toContain('rel="prev"');
  });

  it('renders nothing for a single page', async () => {
    const { html } = await createSsrRenderer(resolve)({ component: 'people/List', props: { page: 1, lastPage: 1 }, url: '/people' });
    expect(html).toBe('');
  });

  it('shows first, last and a window, with gaps', () => {
    expect(pagesAround(6, 20, 2)).toEqual([1, null, 4, 5, 6, 7, 8, null, 20]);
    expect(pagesAround(1, 3, 2)).toEqual([1, 2, 3]);
    expect(pagesAround(2, 9, 1)).toEqual([1, 2, 3, null, 9]);
  });
});
