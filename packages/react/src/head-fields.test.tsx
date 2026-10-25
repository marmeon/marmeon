// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { defaultTitle, Head, HeadContext, type HeadProps } from './head.tsx';
import { HeadRegistry, languagesOf } from './head-fields.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let registry: HeadRegistry;
let warn: Mock<(message: string) => void>;
/** Which page is shown: a new value unmounts the old `<Head>`s and mounts new ones, as a navigation does. */
let page = 0;

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  warn = vi.fn<(message: string) => void>();
  registry = new HeadRegistry(undefined, warn);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.head.innerHTML = '';
});

/** The `<Head>`s of a page (a layout's, then the page's), under the registry like the app's. */
async function show(...heads: HeadProps[]) {
  await act(async () => {
    root.render(
      <HeadContext.Provider value={{ template: defaultTitle, fields: registry }}>
        {heads.map((props, index) => (
          <Head key={`${page}:${index}`} {...props} />
        ))}
      </HeadContext.Provider>,
    );
  });
}

const managed = () => [...document.head.querySelectorAll('[data-marmeon-head="meta"]')];
const meta = (selector: string) => document.head.querySelector(selector)?.getAttribute('content');

describe('<Head> fields in the browser', () => {
  it('writes the merged fields, with URLs made absolute against the browser origin', async () => {
    await show({ description: 'Layout', openGraph: { siteName: 'Shop' } }, { title: 'Page', canonical: '/a', openGraph: { image: '/x.png' } });
    expect(meta('meta[name="description"]')).toBe('Layout');
    expect(meta('meta[property="og:site_name"]')).toBe('Shop');
    expect(meta('meta[property="og:title"]')).toBe('Page');
    expect(meta('meta[property="og:image"]')).toBe('https://app.test/x.png');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://app.test/a');
  });

  it('replaces a field on navigation, removes the ones the next page does not set and never doubles one', async () => {
    await show({ description: 'One', openGraph: { image: '/one.png' } });
    const description = document.head.querySelector('meta[name="description"]');
    page++;
    await show({ description: 'Two' });
    expect(meta('meta[name="description"]')).toBe('Two');
    expect(document.head.querySelector('meta[name="description"]')).toBe(description);
    expect(document.head.querySelector('meta[property^="og:"]')).toBeNull();
    page++;
    await show({ description: 'Three' });
    page++;
    await show({ description: 'Three' });
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(managed()).toHaveLength(1);
  });

  it('takes over from the tags the server rendered', async () => {
    document.head.innerHTML = '<meta name="description" content="server" data-marmeon-head="ssr"/>';
    await show({ description: 'client' });
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(meta('meta[name="description"]')).toBe('client');
  });

  it('removes everything when the last <Head> goes away', async () => {
    await show({ description: 'One', twitter: { card: 'summary' } });
    await show();
    expect(managed()).toHaveLength(0);
  });

  it('resolves against the origin the server gave, not the browser\'s — and the browser\'s without one', async () => {
    registry = new HeadRegistry('https://www.example.com', warn);
    await show({ canonical: '/a', openGraph: { url: '/a', image: '/x.png' } });
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://www.example.com/a');
    expect(meta('meta[property="og:url"]')).toBe('https://www.example.com/a');
    expect(meta('meta[property="og:image"]')).toBe('https://www.example.com/x.png');
    expect(location.origin).toBe('https://app.test');
  });

  it('drops a path that names another host', async () => {
    await show({ canonical: '//evil.example/x', openGraph: { image: '/\\evil.example/x' } });
    expect(document.head.innerHTML).not.toContain('evil.example');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops a URL that is not http(s) and says so', async () => {
    await show({ openGraph: { image: 'javascript:alert(1)' } });
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped "javascript:alert(1)"'));
  });

  it('follows a navigation between languages and to a page that is not localized', async () => {
    const hreflangs = () => [...document.head.querySelectorAll('link[rel="alternate"]')].map((link) => `${link.getAttribute('hreflang')} ${link.getAttribute('href')}`);
    await show({ description: 'a' });
    registry.setLanguages(languagesOf({ locale: 'en', alternates: { en: '/en/a?utm_x=1', de: '/de/a?utm_x=1', 'x-default': '/a?utm_x=1' } }));
    expect(hreflangs()).toEqual(['en https://app.test/en/a', 'de https://app.test/de/a', 'x-default https://app.test/a']);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://app.test/en/a');
    const english = document.head.querySelector('link[rel="alternate"][hreflang="en"]');
    registry.setLanguages(languagesOf({ locale: 'de', alternates: { en: '/en/b', de: '/de/b', 'x-default': '/b' } }));
    expect(hreflangs()).toEqual(['en https://app.test/en/b', 'de https://app.test/de/b', 'x-default https://app.test/b']);
    expect(document.head.querySelector('link[rel="alternate"][hreflang="en"]')).toBe(english);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://app.test/de/b');
    registry.setLanguages(languagesOf({ locale: 'de' }));
    expect(hreflangs()).toEqual([]);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
  });

  it('keeps the origin of the app for the alternates and drops a path that names another host', async () => {
    registry = new HeadRegistry('https://www.example.com', warn);
    registry.setLanguages(languagesOf({ locale: 'en', alternates: { en: '//evil.example/en', de: '/de' } }));
    expect(document.head.innerHTML).not.toContain('evil.example');
    registry.setLanguages(languagesOf({ locale: 'en', alternates: { en: '/en', de: '/de' } }));
    expect(document.head.querySelector('link[hreflang="de"]')?.getAttribute('href')).toBe('https://www.example.com/de');
  });

  it('takes over the field tags the server wrote on a page without a <Head>, once each', async () => {
    document.head.innerHTML =
      '<title data-marmeon-head="ssr">T</title><link rel="canonical" href="https://app.test/en/a" data-marmeon-head="ssr"/>' +
      '<link rel="alternate" hreflang="en" href="https://app.test/en/a" data-marmeon-head="ssr"/><link rel="alternate" hreflang="de" href="https://app.test/de/a" data-marmeon-head="ssr"/>';
    registry.setLanguages(languagesOf({ locale: 'en', alternates: { en: '/en/a', de: '/de/a' } }));
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="alternate"]')).toHaveLength(2);
    expect(document.head.querySelector('title')).not.toBeNull();
    registry.setLanguages(undefined);
    expect(document.head.querySelector('link[rel="canonical"], link[rel="alternate"]')).toBeNull();
  });

  it('leaves the server\'s other field tags to the <Head> that takes them over later', async () => {
    document.head.innerHTML =
      '<meta name="description" content="server" data-marmeon-head="ssr"/><link rel="canonical" href="https://app.test/en/a" data-marmeon-head="ssr"/>';
    registry.setLanguages(languagesOf({ locale: 'en', alternates: { en: '/en/a' } }));
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    await show({ description: 'client' });
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(meta('meta[name="description"]')).toBe('client');
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  });
});

describe('<Head jsonLd> in the browser', () => {
  const blocks = () => [...document.head.querySelectorAll('script[type="application/ld+json"]')] as HTMLElement[];

  it('writes each block as the text of a script, whatever the text says', async () => {
    const value = { '@type': 'Person', name: '</script><script>alert(1)</script><!--' };
    await show({ jsonLd: [value, { '@type': 'Article' }] });
    expect(blocks()).toHaveLength(2);
    expect(JSON.parse(blocks()[0]!.textContent!)).toEqual(value);
    expect(blocks()[0]!.children).toHaveLength(0);
    expect(document.head.querySelectorAll('script')).toHaveLength(2);
  });

  it('replaces the block on navigation and removes it when the next page has none', async () => {
    await show({ jsonLd: { '@type': 'Article', headline: 'One' } });
    const first = blocks()[0];
    page++;
    await show({ jsonLd: { '@type': 'Article', headline: 'Two' } });
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]).toBe(first);
    expect(JSON.parse(blocks()[0]!.textContent!).headline).toBe('Two');
    page++;
    await show({ description: 'No data' });
    expect(blocks()).toHaveLength(0);
  });

  it('takes over from the block the server rendered', async () => {
    document.head.innerHTML = '<script type="application/ld+json" data-marmeon-head="ssr">{"@type":"Article"}</script>';
    await show({ jsonLd: { '@type': 'Article' } });
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]!.getAttribute('data-marmeon-head')).toBe('meta');
  });

  it('removes the block and warns when Trusted Types refuses its text', async () => {
    // What a `require-trusted-types-for 'script'` policy does: setting a script's text throws.
    Object.defineProperty(HTMLScriptElement.prototype, 'textContent', {
      configurable: true,
      get: () => '',
      set() {
        throw new TypeError('This document requires TrustedScript assignment.');
      },
    });
    try {
      await show({ description: 'Kept', jsonLd: { '@type': 'Article' } });
    } finally {
      delete (HTMLScriptElement.prototype as { textContent?: string }).textContent;
    }
    expect(blocks()).toHaveLength(0);
    expect(meta('meta[name="description"]')).toBe('Kept');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('require-trusted-types-for'));
  });

  it('names a block that is no JSON in development', async () => {
    const cycle: Record<string, unknown> = { '@type': 'Article' };
    cycle.self = cycle;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(show({ jsonLd: cycle as never })).rejects.toThrow('@type "Article"');
    } finally {
      error.mockRestore();
    }
  });
});
