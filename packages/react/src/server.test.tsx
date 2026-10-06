import { Suspense, use, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { usePage, useRouter } from './app.tsx';
import { Head } from './head.tsx';
import { resolveModulePages } from './pages.ts';
import { Pagination, pagesAround } from './pagination.tsx';
import { createSsrRenderer } from './server.tsx';
import type { SsrRender, SsrRenderOptions } from '@bespokecore/http/page';

/** The markup as a string — streamed SSR reads to the end. */
async function text(html: string | ReadableStream<Uint8Array>): Promise<string> {
  return typeof html === 'string' ? html : new Response(html).text();
}

/** Renders and reads the whole markup. */
async function renderAll(render: SsrRender, page: Parameters<SsrRender>[0], options?: SsrRenderOptions): Promise<{ html: string; head?: string }> {
  const result = await render(page, options);
  return { html: await text(result.html), head: result.head };
}

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

/** A page that builds its reloads and patches while it renders — for its actions, which run in the browser. */
function Inbox({ count }: { count: number }) {
  const router = useRouter<{ count: number }>();
  const reload = router.reloading({ only: ['count'] });
  const patch = router.optimistic(() => ({ count: 0 }));
  return <p>{count} {reload.length} {typeof patch}</p>;
}

const resolve = resolveModulePages({
  '../modules/greeting/views/Inbox.tsx': async () => ({ default: Inbox }),
  '../modules/greeting/views/Titled.tsx': async () => ({ default: Titled }),
  '../modules/greeting/views/Hello.tsx': async () => ({ default: Greeting }),
  '../modules/broken/views/NoDefault.tsx': async () => ({}),
  '../elsewhere/Ignored.tsx': async () => ({ default: Greeting }),
  '../modules/people/views/List.tsx': async () => ({ default: ({ page, lastPage }: { page: number; lastPage: number }) => <Pagination meta={{ page, perPage: 5, total: lastPage * 5, lastPage, from: 1, to: 5 }} /> }),
  '../modules/people/views/Labelled.tsx': async () => ({
    default: ({ page, lastPage }: { page: number; lastPage: number }) => (
      <Pagination meta={{ page, perPage: 5, total: lastPage * 5, lastPage, from: 1, to: 5 }} labels={{ next: 'Suivant', page: (number) => `Page n° ${number}` }} />
    ),
  }),
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
    const { html } = await renderAll(render, { component: 'greeting/Hello', props: { name: 'Ada' }, url: '/hi' });
    expect(html).toBe('<p>Hello <!-- -->Ada<!-- --> at <!-- -->/hi</p>');
  });

  it('counter-check: renders a page that builds reloads and optimistic patches while rendering (W9 step 10b: it failed with R11)', async () => {
    const render = createSsrRenderer(resolve);
    const { html } = await renderAll(render, { component: 'greeting/Inbox', props: { count: 3 }, url: '/inbox' });
    expect(html).toBe('<p>3<!-- --> <!-- -->1<!-- --> <!-- -->object</p>');
  });
});

describe('<Head> on the server', () => {
  it('collects title (through the template, escaped, the last one wins) and tags for the document head', async () => {
    const render = createSsrRenderer(resolve, { title: (title) => `${title} — Shop` });
    const { html, head } = await renderAll(render, { component: 'greeting/Titled', props: { name: 'Ada' }, url: '/ada' });
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
    expect((await renderAll(render, { component: 'app/Hello', props: { name: 'Ada' }, url: '/' })).html).toBe('<div class="shell"><p>Hello <!-- -->Ada<!-- --> at <!-- -->/</p></div>');
    expect((await renderAll(render, { component: 'app/Own', props: {}, url: '/' })).html).toBe('<div class="shell"><section><p>own</p></section></div>');
  });

  it('refuses a layout that is not a component', async () => {
    await expect(withLayouts('app/Broken')).rejects.toThrow('Page [app/Broken] has an invalid layout: expected a component (or a list of them), got Shell.');
  });
});

describe('<Pagination>', () => {
  it('links the pages around the current one — keeping the rest of the query string', async () => {
    const { html } = await renderAll(createSsrRenderer(resolve), { component: 'people/List', props: { page: 6, lastPage: 20 }, url: '/people?q=ada&page=6' });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
    expect(hrefs).toEqual(['/people?q=ada&page=5', '/people?q=ada', '/people?q=ada&page=4', '/people?q=ada&page=5', '/people?q=ada&page=7', '/people?q=ada&page=8', '/people?q=ada&page=20', '/people?q=ada&page=7']);
    expect(html).toContain('<strong aria-current="page"> <!-- -->6<!-- --> </strong>');
    expect(html).toContain('rel="prev"');
  });

  it('takes its links from the parsed query (E55): the rest of it kept, its defaults left out — the address is never parsed', async () => {
    // The URL says one thing, the page's parsed query another: the links follow the query (the schema's view of the URL).
    const { html } = await renderAll(createSsrRenderer(resolve), {
      component: 'people/List',
      props: { page: 2, lastPage: 3 },
      url: '/people?ignored=1&page=2',
      query: { q: 'ada', page: 2, per_page: 50 },
      queryDefaults: { q: '', sort: 'name', page: 1, per_page: 25 },
    });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
    expect(hrefs, 'the links parsed the address').toEqual(['/people?q=ada&per_page=50', '/people?q=ada&per_page=50', '/people?q=ada&page=3&per_page=50', '/people?q=ada&page=3&per_page=50']);
  });

  it('speaks English by itself — the page’s language comes from the app (labels, E38), whatever the page’s locale', async () => {
    const english = await renderAll(createSsrRenderer(resolve), { component: 'people/List', props: { page: 2, lastPage: 3 }, url: '/people?page=2', locale: 'de' });
    expect(english.html).toContain('aria-label="Pagination"');
    expect(english.html).toContain('Next ›');
    expect(english.html).toContain('aria-label="Page 3"');
    const labelled = await renderAll(createSsrRenderer(resolve), { component: 'people/Labelled', props: { page: 2, lastPage: 3 }, url: '/people?page=2', locale: 'fr' });
    expect(labelled.html).toContain('Suivant');
    expect(labelled.html).toContain('aria-label="Page n° 3"');
    expect(labelled.html).toContain('‹ Previous');
  });

  it('renders nothing for a single page', async () => {
    const { html } = await renderAll(createSsrRenderer(resolve), { component: 'people/List', props: { page: 1, lastPage: 1 }, url: '/people' });
    expect(html).toBe('');
  });

  it('shows first, last and a window, with gaps', () => {
    expect(pagesAround(6, 20, 2)).toEqual([1, null, 4, 5, 6, 7, 8, null, 20]);
    expect(pagesAround(1, 3, 2)).toEqual([1, 2, 3]);
    expect(pagesAround(2, 9, 1)).toEqual([1, 2, 3, null, 9]);
  });
});

describe('streaming SSR (E37)', () => {
  /** A promise the test settles — what a slow part of a page waits for. */
  function later<T>() {
    let settle!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  }

  function pages(slow: Promise<string>) {
    function Part() {
      return <b>{use(slow)}</b>;
    }
    function Slow() {
      return (
        <main>
          <p>shell</p>
          <Suspense fallback={<i>loading</i>}>
            <Part />
          </Suspense>
        </main>
      );
    }
    const Complete = Object.assign(() => <Slow />, { ssr: 'complete' as const });
    const BrowserOnly = Object.assign(() => <p>{window.innerWidth}</p>, { ssr: false });
    function Throws(): ReactNode {
      throw new Error('window is not defined');
    }
    /** A <Head> next to the slow part: rendered with the shell (and again when the boundary retries). */
    function HeadBeside() {
      return (
        <Suspense fallback={<i>loading</i>}>
          <Head title="Beside">
            <meta name="beside" content="yes" />
          </Head>
          <Part />
        </Suspense>
      );
    }
    /** A <Head> inside the slow part: rendered only once it has loaded — after the shell. */
    function LatePart() {
      const value = use(slow);
      return (
        <>
          <Head title="Late" />
          <b>{value}</b>
        </>
      );
    }
    function LateHead() {
      return (
        <Suspense fallback={<i>loading</i>}>
          <LatePart />
        </Suspense>
      );
    }
    return resolveModulePages({
      '../modules/app/views/Slow.tsx': async () => ({ default: Slow }),
      '../modules/app/views/Complete.tsx': async () => ({ default: Complete }),
      '../modules/app/views/BrowserOnly.tsx': async () => ({ default: BrowserOnly }),
      '../modules/app/views/Throws.tsx': async () => ({ default: Throws }),
      '../modules/app/views/LateHead.tsx': async () => ({ default: LateHead }),
      '../modules/app/views/HeadBeside.tsx': async () => ({ default: HeadBeside }),
    });
  }
  const page = (component: string) => ({ component, props: {}, url: '/' });

  it('resolves with the shell while a Suspense boundary still loads — the boundary follows in the same stream', async () => {
    const slow = later<string>();
    const result = await createSsrRenderer(pages(slow.promise))(page('app/Slow'));
    expect(typeof result.html).not.toBe('string');
    const reading = text(result.html);
    slow.settle('the slow part');
    const html = await reading;
    expect(html).toMatch(/^<main><p>shell<\/p><!--\$\?--><template id="B:0"><\/template><i>loading<\/i><!--\/\$--><\/main>/);
    expect(html).toContain('<div hidden id="S:0"><b>the slow part</b></div>');
  });

  it("waits for the whole page with `complete` (bots) and for pages with ssr = 'complete'", async () => {
    for (const [component, options] of [['app/Slow', { complete: true }], ['app/Complete', {}]] as const) {
      const slow = later<string>();
      let resolved = false;
      const rendering = createSsrRenderer(pages(slow.promise))(page(component), options).then((result) => {
        resolved = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resolved).toBe(false);
      slow.settle('the slow part');
      const html = await text((await rendering).html);
      expect(html).toBe('<main><p>shell</p><!--$--><b>the slow part</b><!--/$--></main>');
    }
  });

  it('renders no markup for a page with ssr = false — the browser renders it', async () => {
    const { html, head } = await renderAll(createSsrRenderer(pages(Promise.resolve('')), { title: (title) => title || 'Shop' }), page('app/BrowserOnly'));
    expect(html).toBe('');
    expect(head).toBe('<title data-bespoke-head="ssr">Shop</title>');
  });

  it('rejects when the shell fails — the server then sends the page without markup', async () => {
    const onError = vi.fn();
    await expect(createSsrRenderer(pages(Promise.resolve('')))(page('app/Throws'), { onError })).rejects.toThrow('window is not defined');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an error after the shell and still delivers the page: the browser renders that boundary', async () => {
    const slow = later<string>();
    const onError = vi.fn();
    const result = await createSsrRenderer(pages(slow.promise))(page('app/Slow'), { onError });
    const reading = text(result.html);
    slow.fail(new Error('the database went away'));
    const html = await reading;
    expect(onError).toHaveBeenCalledWith(new Error('the database went away'));
    expect(html).toContain('<p>shell</p>');
    // The boundary is marked for the browser to render, with our digest (no message in production).
    expect(html).toContain('$RX("B:0","bespoke:ssr"');
  });

  it('warns in development about a <Head> that renders after the head was sent', async () => {
    const slow = later<string>();
    const onWarning = vi.fn();
    const result = await createSsrRenderer(pages(slow.promise))(page('app/LateHead'), { onWarning });
    const reading = text(result.html);
    slow.settle('done');
    await reading;
    expect(result.head).not.toContain('Late');
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('<Head title="Late"> in [app/LateHead] rendered after the document head was sent'));
  });

  it('collects a <Head> beside a slow part with the shell — once, without a warning', async () => {
    const slow = later<string>();
    const onWarning = vi.fn();
    const rendering = createSsrRenderer(pages(slow.promise))(page('app/HeadBeside'), { complete: true, onWarning });
    setTimeout(() => slow.settle('done'), 10);
    const { head } = await rendering;
    expect(head).toBe('<title data-bespoke-head="ssr">Beside</title><meta name="beside" content="yes" data-bespoke-head="ssr"/>');
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('has the late <Head> in the head when the page is rendered completely', async () => {
    const slow = later<string>();
    const rendering = createSsrRenderer(pages(slow.promise))(page('app/LateHead'), { complete: true });
    setTimeout(() => slow.settle('done'), 10);
    expect((await rendering).head).toBe('<title data-bespoke-head="ssr">Late</title>');
  });
});
