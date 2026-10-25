// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { defaultTitle, Head, HeadContext, type HeadProps } from './head.tsx';
import { HeadRegistry } from './head-fields.ts';

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
});
