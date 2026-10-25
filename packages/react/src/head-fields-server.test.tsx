import { describe, expect, it, vi } from 'vitest';
import { Head, type HeadProps } from './head.tsx';
import { mergeHead } from './head-fields.ts';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';
import type { SsrRender, SsrRenderOptions } from '@marmeon/http/page';

const APP_URL = 'https://app.example';

/** A page whose `<Head>`s are its props: the first stands for the layout, the next for the page. */
function Heads({ heads }: { heads: HeadProps[] }) {
  return (
    <>
      {heads.map((props, index) => (
        <Head key={index} {...props} />
      ))}
    </>
  );
}

const render = createSsrRenderer(resolveModulePages({ '/modules/seo/views/Heads.tsx': async () => ({ default: Heads }) }), {
  title: (title) => (title ? `${title} — Shop` : 'Shop'),
});

async function headOf(heads: HeadProps[], options: SsrRenderOptions = { appUrl: APP_URL }): Promise<string> {
  const result = await (render as SsrRender)({ component: 'seo/Heads', props: { heads }, url: '/' }, options);
  return result.head ?? '';
}

describe('<Head> fields on the server', () => {
  it('writes every field into the head', async () => {
    const head = await headOf([
      {
        title: 'Ada',
        description: 'A profile',
        canonical: '/people/ada',
        robots: { index: false, follow: true },
        openGraph: { type: 'profile', url: '/people/ada', siteName: 'Shop', locale: 'en', image: { url: '/ada.png', width: 600, height: 400, alt: 'Ada' } },
        twitter: { card: 'summary_large_image', site: '@shop', creator: '@ada', image: '/ada.png', imageAlt: 'Ada' },
      },
    ]);
    expect(head).toBe(
      [
        '<title data-marmeon-head="ssr">Ada — Shop</title>',
        '<meta name="description" content="A profile" data-marmeon-head="ssr"/>',
        '<link rel="canonical" href="https://app.example/people/ada" data-marmeon-head="ssr"/>',
        '<meta name="robots" content="noindex, follow" data-marmeon-head="ssr"/>',
        '<meta property="og:title" content="Ada" data-marmeon-head="ssr"/>',
        '<meta property="og:description" content="A profile" data-marmeon-head="ssr"/>',
        '<meta property="og:type" content="profile" data-marmeon-head="ssr"/>',
        '<meta property="og:url" content="https://app.example/people/ada" data-marmeon-head="ssr"/>',
        '<meta property="og:site_name" content="Shop" data-marmeon-head="ssr"/>',
        '<meta property="og:locale" content="en" data-marmeon-head="ssr"/>',
        '<meta property="og:image" content="https://app.example/ada.png" data-marmeon-head="ssr"/>',
        '<meta property="og:image:width" content="600" data-marmeon-head="ssr"/>',
        '<meta property="og:image:height" content="400" data-marmeon-head="ssr"/>',
        '<meta property="og:image:alt" content="Ada" data-marmeon-head="ssr"/>',
        '<meta name="twitter:card" content="summary_large_image" data-marmeon-head="ssr"/>',
        '<meta name="twitter:site" content="@shop" data-marmeon-head="ssr"/>',
        '<meta name="twitter:creator" content="@ada" data-marmeon-head="ssr"/>',
        '<meta name="twitter:title" content="Ada" data-marmeon-head="ssr"/>',
        '<meta name="twitter:description" content="A profile" data-marmeon-head="ssr"/>',
        '<meta name="twitter:image" content="https://app.example/ada.png" data-marmeon-head="ssr"/>',
        '<meta name="twitter:image:alt" content="Ada" data-marmeon-head="ssr"/>',
      ].join(''),
    );
  });

  it('writes an article with its authors and tags, one tag each', async () => {
    const head = await headOf([{ openGraph: { type: 'article', article: { publishedTime: '2026-01-02T03:04:05Z', authors: ['Ada', 'Alan'], tags: ['a', 'b'] } } }]);
    expect(head).toContain('<meta property="article:published_time" content="2026-01-02T03:04:05Z" data-marmeon-head="ssr"/>');
    expect(head.match(/property="article:author" content="(\w+)"/g)).toEqual(['property="article:author" content="Ada"', 'property="article:author" content="Alan"']);
    expect(head.match(/property="article:tag"/g)).toHaveLength(2);
  });

  it('merges a layout and its page: the page wins per key', async () => {
    const head = await headOf([
      { description: 'Layout', openGraph: { siteName: 'Shop', title: 'Layout title' }, robots: { follow: false } },
      { title: 'Page', openGraph: { title: 'Page title' }, robots: { index: false } },
    ]);
    expect(head).toContain('<meta name="description" content="Layout" data-marmeon-head="ssr"/>');
    expect(head).toContain('<meta property="og:site_name" content="Shop" data-marmeon-head="ssr"/>');
    expect(head).toContain('<meta property="og:title" content="Page title" data-marmeon-head="ssr"/>');
    expect(head).not.toContain('Layout title');
    expect(head).toContain('<meta name="robots" content="noindex, nofollow" data-marmeon-head="ssr"/>');
  });

  it('falls back to the raw title and the description, only for an object that is set', async () => {
    const withOg = await headOf([{ title: 'Ada', description: 'About Ada', openGraph: {}, twitter: { card: 'summary' } }]);
    expect(withOg).toContain('<meta property="og:title" content="Ada" data-marmeon-head="ssr"/>');
    expect(withOg).toContain('<meta name="twitter:description" content="About Ada" data-marmeon-head="ssr"/>');
    const without = await headOf([{ title: 'Ada', description: 'About Ada' }]);
    expect(without).not.toContain('og:');
    expect(without).not.toContain('twitter:');
  });

  it('escapes the values', async () => {
    const head = await headOf([{ description: '"><script>alert(1)&</script>', openGraph: { siteName: `' onload='x` } }]);
    expect(head).toContain('content="&#34;&#62;&#60;script&#62;alert(1)&#38;&#60;/script&#62;"');
    expect(head).not.toContain('<script>');
    expect(head).toContain('content="&#39; onload=&#39;x"');
  });

  it('makes a relative image absolute with APP_URL and keeps an absolute one', async () => {
    const relative = await headOf([{ openGraph: { image: 'cover.png' }, canonical: '/a?b=1' }]);
    expect(relative).toContain('property="og:image" content="https://app.example/cover.png"');
    expect(relative).toContain('href="https://app.example/a?b=1"');
    const absolute = await headOf([{ openGraph: { image: 'https://cdn.example/x.png' } }]);
    expect(absolute).toContain('content="https://cdn.example/x.png"');
  });

  it('drops a URL that is not http(s), with a warning in development', async () => {
    const onWarning = vi.fn();
    const head = await headOf([{ openGraph: { image: 'javascript:alert(1)' }, twitter: { card: 'summary', image: 'data:image/png;base64,AA' }, canonical: 'ftp://x.example/' }], { appUrl: APP_URL, onWarning });
    expect(head).not.toContain('javascript');
    expect(head).not.toContain('data:image');
    expect(head).not.toContain('canonical');
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('dropped "javascript:alert(1)"'));
  });

  it('drops a path that names another host, whatever the slashes', async () => {
    const onWarning = vi.fn();
    const head = await headOf(
      [{ canonical: '//evil.example/x', openGraph: { image: '/\\evil.example/x', url: '\\\\evil.example/x' }, twitter: { card: 'summary', image: ' //evil.example/y' } }],
      { appUrl: APP_URL, onWarning },
    );
    expect(head).not.toContain('evil.example');
    expect(onWarning).toHaveBeenCalledTimes(4);
  });

  it('writes twitter:card only when a card is set — a layout sets it once', async () => {
    const head = await headOf([{ twitter: { card: 'summary' } }, { twitter: { site: '@shop' } }]);
    expect(head).toContain('name="twitter:card" content="summary"');
    expect(await headOf([{ twitter: { site: '@shop' } }])).not.toContain('twitter:card');
  });

  it('names an APP_URL that is no URL, even for an absolute value', async () => {
    const onWarning = vi.fn();
    await headOf([{ canonical: 'https://x.example/' }], { appUrl: 'not a url', onWarning });
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('is not a URL'));
  });

  it('drops a relative URL without an APP_URL — never guesses one', async () => {
    const onWarning = vi.fn();
    const head = await headOf([{ canonical: '/a', openGraph: { image: 'https://cdn.example/x.png' } }], { onWarning });
    expect(head).not.toContain('canonical');
    expect(head).toContain('content="https://cdn.example/x.png"');
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('APP_URL'));
  });

  it('takes the app URL from the option, not from the page URL', async () => {
    const result = await (render as SsrRender)({ component: 'seo/Heads', props: { heads: [{ canonical: '/a' }] }, url: 'https://evil.example/a' }, { appUrl: APP_URL });
    expect(result.head).toContain('href="https://app.example/a"');
  });
});

describe('mergeHead', () => {
  it('takes the last simple field and merges objects key by key', () => {
    expect(mergeHead([{ title: 'A', canonical: '/a', openGraph: { siteName: 'S', title: 'x' } }, { title: 'B', openGraph: { title: 'y', image: undefined } }])).toEqual({
      title: 'B',
      canonical: '/a',
      openGraph: { siteName: 'S', title: 'y' },
    });
  });
});
