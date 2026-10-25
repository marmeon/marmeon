// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SsrRender } from '@marmeon/http/page';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';
import { defaultTitle, Head, HeadContext, sweepServerTags, type HeadProps } from './head.tsx';
import { HeadRegistry } from './head-fields.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let registry: HeadRegistry;
/** Which page is shown: a new value unmounts the old `<Head>` and mounts a new one, as a navigation does. */
let page = 0;

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  registry = new HeadRegistry();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.head.innerHTML = '';
});

async function show(props: HeadProps) {
  await act(async () => {
    root.render(
      <HeadContext.Provider value={{ template: defaultTitle, fields: registry }}>
        <Head key={page} {...props} />
      </HeadContext.Provider>,
    );
  });
}

const scripts = () => [...document.head.querySelectorAll('script[src]')];
const nonceOf = (element: Element) => (element as HTMLElement).nonce || element.getAttribute('nonce');

describe('the tags inside <Head> in the browser', () => {
  it('takes over the script the server rendered instead of writing a second one', async () => {
    document.head.innerHTML = '<script type="text/plain" src="/widget.js" async="" nonce="n1" data-marmeon-head="ssr-tag"></script>';
    const rendered = scripts()[0]!;
    await show({ children: <script type="text/plain" src="/widget.js" async /> });
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).toBe(rendered);
    expect(rendered.getAttribute('data-marmeon-head')).toBe('client');
  });

  it('writes a script the server did not render, and a changed one anew', async () => {
    document.head.innerHTML = '<script type="text/plain" src="/old.js" data-marmeon-head="ssr-tag"></script>';
    const rendered = scripts()[0]!;
    await show({ children: <script type="text/plain" src="/new.js" /> });
    expect(scripts().map((script) => script.getAttribute('src'))).toEqual(['/old.js', '/new.js']);
    expect(scripts()[0]).toBe(rendered);
    sweepServerTags();
    expect(scripts().map((script) => script.getAttribute('src'))).toEqual(['/new.js']);
  });

  it('sets no event handler attribute from a function prop', async () => {
    await show({
      children: [
        <link key="l" rel="alternate" href="/a.css" onLoad={() => alert('loaded')} />,
        <script key="s" type="text/plain" src="/b.js" onError={() => alert('failed')} />,
        <meta key="m" name="x" content="y" onClick={() => alert('clicked')} />,
      ],
    });
    const tags = [...document.head.querySelectorAll('[data-marmeon-head="client"]')];
    expect(tags).toHaveLength(3);
    for (const tag of tags) expect([...tag.attributes].filter((attribute) => attribute.name.startsWith('on'))).toEqual([]);
  });

  it('sets no attribute from an object, and writes className as class', async () => {
    await show({ children: <link rel="alternate" href="/a.css" className="theme" style={{ color: 'red' }} /> });
    const link = document.head.querySelector('link[rel="alternate"]')!;
    expect(link.getAttribute('class')).toBe('theme');
    expect(link.hasAttribute('style')).toBe(false);
    expect(link.hasAttribute('classname')).toBe(false);
  });

  it('keeps the text of a style', async () => {
    await show({ children: <style>{'p > a { color: red }'}</style> });
    expect(document.head.querySelector('style[data-marmeon-head="client"]')!.textContent).toBe('p > a { color: red }');
  });

  it('takes over a style with the same text, and not one with other text', async () => {
    document.head.innerHTML = '<style data-marmeon-head="ssr-tag">a{color:red}</style>';
    const rendered = document.head.querySelector('style')!;
    await show({ children: <style>{'a{color:red}'}</style> });
    expect(document.head.querySelectorAll('style')).toHaveLength(1);
    expect(document.head.querySelector('style')).toBe(rendered);
    page++;
    await show({ children: <style>{'a{color:blue}'}</style> });
    expect(document.head.querySelector('style')!.textContent).toBe('a{color:blue}');
  });

  it('gives a new script and style the nonce of the page, whatever the tag says', async () => {
    document.head.innerHTML = '<script type="text/plain" src="/entry.js" nonce="page-nonce"></script>';
    await show({ children: [<script key="s" type="text/plain" src="/b.js" nonce="mine" />, <style key="t" nonce="mine">{'a{}'}</style>, <meta key="m" name="x" content="y" />] });
    expect(nonceOf(document.head.querySelector('script[src="/b.js"]')!)).toBe('page-nonce');
    expect(nonceOf(document.head.querySelector('style')!)).toBe('page-nonce');
    expect(document.head.querySelector('meta[name="x"]')!.hasAttribute('nonce')).toBe(false);
  });

  it('gives no nonce when the page has none', async () => {
    await show({ children: <script type="text/plain" src="/b.js" nonce="mine" /> });
    expect(document.head.querySelector('script[src="/b.js"]')!.hasAttribute('nonce')).toBe(false);
  });

  it('removes what it wrote, taken-over tags included, when its page goes', async () => {
    document.head.innerHTML = '<style data-marmeon-head="ssr-tag">a{}</style>';
    await show({ children: [<style key="s">{'a{}'}</style>, <meta key="m" name="x" content="y" />] });
    page++;
    await show({ description: 'Next' });
    expect(document.head.querySelector('style')).toBeNull();
    expect(document.head.querySelector('meta[name="x"]')).toBeNull();
  });

  it('resolves the fields against the origin of an app URL that has a path', async () => {
    registry = new HeadRegistry('https://app.test/shop/');
    await show({ canonical: 'products', openGraph: { image: 'img/a.png' } });
    expect(document.head.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe('https://app.test/products');
    expect(document.head.querySelector('meta[property="og:image"]')!.getAttribute('content')).toBe('https://app.test/img/a.png');
  });
});

describe('the tags inside <Head> after the server rendered them', () => {
  let tags: ReactNode = null;
  const render = createSsrRenderer(resolveModulePages({ '/modules/x/views/Page.tsx': async () => ({ default: () => <Head>{tags}</Head> }) }), {});

  /** The head the server writes for these tags, in the document; then the client's `<Head>` with the same. */
  async function roundTrip(children: ReactNode, nonce?: string) {
    tags = children;
    const result = await (render as SsrRender)({ component: 'x/Page', props: {}, url: '/' }, { nonce });
    document.head.innerHTML = result.head ?? '';
    const written = [...document.head.querySelectorAll('[data-marmeon-head="ssr-tag"]')];
    await show({ children });
    return written;
  }

  const adopted = (written: Element[]) => {
    expect(written.length).toBeGreaterThan(0);
    for (const element of written) {
      expect(element.isConnected).toBe(true);
      expect(element.getAttribute('data-marmeon-head')).toBe('client');
    }
    expect(document.head.querySelectorAll('[data-marmeon-head]')).toHaveLength(written.length);
  };

  it('takes over scripts, styles and links with the attributes React writes', async () => {
    adopted(
      await roundTrip([
        <script key="a" type="text/plain" src="/a.js" async defer data-on aria-hidden={false} data-off={false} className="x" suppressHydrationWarning />,
        <link key="b" rel="alternate" href="/b" hrefLang="de" crossOrigin="anonymous" />,
        <meta key="c" name="n" content="1" httpEquiv="refresh" />,
        <style key="d" media="print">{'a{color:red}'}</style>,
      ]),
    );
  });

  it('takes over boolean attributes given a string, and download as written', async () => {
    adopted(
      await roundTrip([
        <script key="a" type="text/plain" src="/a.js" async={'yes' as never} defer={'false' as never} />,
        <link key="b" rel="alternate" href="/b" {...({ download: "name.txt" } as object)} />,
        <meta key="c" name="n" content="1" {...({ inert: true } as object)} />,
      ]),
    );
  });

  it('takes over the text of a script or style React escaped', async () => {
    adopted(await roundTrip([<script key="a" type="text/plain">{'a = "</script><SCRIPT>"'}</script>, <style key="b">{'a::after{content:"</style>"}'}</style>]));
  });

  it('takes over a script whose children React does not write as text', async () => {
    adopted(await roundTrip([<script key="a" type="text/plain" src="/a.js">{1}</script>, <script key="b" type="text/plain" src="/b.js">{['a', 'b']}</script>]));
  });

  it('takes over a script and style with the nonce of the response', async () => {
    adopted(await roundTrip([<script key="a" type="text/plain" src="/a.js" nonce="mine" />, <style key="b" nonce="mine">{'a{}'}</style>], 'page-nonce'));
  });
});
