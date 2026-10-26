import { describe, expect, it, vi } from 'vitest';
import { Head, type HeadProps, type JsonLd } from './head.tsx';
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

  it('resolves a relative URL against the origin of an app URL that has a path', async () => {
    const head = await headOf([{ canonical: 'products', openGraph: { image: 'img/a.png' } }], { appUrl: 'https://app.example/shop/' });
    expect(head).toContain('<link rel="canonical" href="https://app.example/products" ');
    expect(head).toContain('content="https://app.example/img/a.png"');
  });

  it('takes the app URL from the option, not from the page URL', async () => {
    const result = await (render as SsrRender)({ component: 'seo/Heads', props: { heads: [{ canonical: '/a' }] }, url: 'https://evil.example/a' }, { appUrl: APP_URL });
    expect(result.head).toContain('href="https://app.example/a"');
  });
});

describe('<Head jsonLd> on the server', () => {
  const blocksOf = (head: string) => [...head.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);

  it.each([
    ['a closing script tag', '</script><script>alert(1)</script>'],
    ['an upper-case closing tag with a space', '</SCRIPT >'],
    ['a comment opener', '<!--'],
    ['an opening script tag', '<script'],
    ['line and paragraph separators', 'a b c'],
    ['a less-than sign in text', 'a < b && c<d'],
  ])('keeps %s inside the block and parses back to the same object', async (_, name) => {
    const value = { '@context': 'https://schema.org', '@type': 'Person', name, nested: { list: [name] } };
    const head = await headOf([{ jsonLd: value }]);
    const [block] = blocksOf(head);
    expect(blocksOf(head)).toHaveLength(1);
    expect(block).not.toContain('<');
    expect(JSON.parse(block!)).toEqual(value);
    // Nothing of the text escaped into the head around the block.
    expect(head.replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, '')).not.toContain('alert');
  });

  it('writes the nonce of the response, and no attribute without one', async () => {
    const withNonce = await headOf([{ jsonLd: { '@type': 'Thing' } }], { appUrl: APP_URL, nonce: 'abc123' });
    expect(withNonce).toContain('<script type="application/ld+json" nonce="abc123" data-marmeon-head="ssr">{"@type":"Thing"}</script>');
    const without = await headOf([{ jsonLd: { '@type': 'Thing' } }]);
    expect(without).toContain('<script type="application/ld+json" data-marmeon-head="ssr">{"@type":"Thing"}</script>');
    expect(without).not.toContain('nonce');
  });

  it('collects the blocks of a layout and its page in render order, an array adding each of its blocks', async () => {
    const head = await headOf([{ jsonLd: { '@type': 'Organization', name: 'Shop' } }, { jsonLd: [{ '@type': 'Article' }, { '@type': 'Person' }] }]);
    expect(blocksOf(head).map((block) => JSON.parse(block)['@type'])).toEqual(['Organization', 'Article', 'Person']);
  });

  it('names the block that is no JSON in development, and leaves it out in production', async () => {
    const cycle: Record<string, unknown> = { '@type': 'Article' };
    cycle.self = cycle;
    await expect(headOf([{ jsonLd: cycle as never }])).rejects.toThrow('@type "Article"');
    await expect(headOf([{ jsonLd: { '@type': ['Thing', 'Event'], count: 1n as never } }])).rejects.toThrow('["Thing","Event"]');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const head = await headOf([{ jsonLd: [cycle as never, { '@type': 'Person' }] }]);
      expect(blocksOf(head).map((block) => JSON.parse(block)['@type'])).toEqual(['Person']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts JSON only: a Date, a function or undefined is a type error', () => {
    // @ts-expect-error a Date is not JSON
    const date: JsonLd = { '@type': 'Article', datePublished: new Date() };
    // @ts-expect-error a function is not JSON
    const callback: JsonLd = { '@type': 'Article', run: () => 1 };
    // @ts-expect-error `undefined` is not JSON
    const missing: JsonLd = { '@type': 'Article', author: undefined };
    // @ts-expect-error every block needs a @type
    const untyped: JsonLd = { name: 'x' };
    expect([date, callback, missing, untyped]).toHaveLength(4);
  });
});

describe('hreflang on the server', () => {
  const alternates = { en: '/en/about', 'de-AT': '/de-AT/about?utm_x=1', 'x-default': '/about?utm_x=1' };
  const pageIn = (locale: string, extra: Record<string, unknown> = {}) => ({ component: 'seo/Heads', props: { heads: [] }, url: '/', locale, alternates, ...extra });
  const link = (hreflang: string, href: string) => `<link rel="alternate" hreflang="${hreflang}" href="${href}" data-marmeon-head="ssr"/>`;

  it('names every language and x-default, and is its own canonical', async () => {
    const result = await (render as SsrRender)(pageIn('de-AT'), { appUrl: APP_URL });
    expect(result.head).toContain('<link rel="canonical" href="https://app.example/de-AT/about" data-marmeon-head="ssr"/>');
    expect(result.head).toContain(link('en', 'https://app.example/en/about'));
    expect(result.head).toContain(link('de-AT', 'https://app.example/de-AT/about'));
    expect(result.head).toContain(link('x-default', 'https://app.example/about'));
    expect(result.head?.match(/rel="alternate"/g)).toHaveLength(3);
    expect(result.head).not.toContain('utm_x');
  });

  it('lets a <Head canonical> win', async () => {
    const result = await (render as SsrRender)(pageIn('en', { props: { heads: [{ canonical: '/the-one' }] } }), { appUrl: APP_URL });
    expect(result.head).toContain('<link rel="canonical" href="https://app.example/the-one" data-marmeon-head="ssr"/>');
    expect(result.head?.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it('gives Open Graph the locale as en_US-style, and the other languages as alternates; an explicit locale wins', async () => {
    const result = await (render as SsrRender)(pageIn('de-AT', { props: { heads: [{ openGraph: { siteName: 'Shop' } }] } }), { appUrl: APP_URL });
    expect(result.head).toContain('<meta property="og:locale" content="de_AT" data-marmeon-head="ssr"/>');
    expect(result.head).toContain('<meta property="og:locale:alternate" content="en" data-marmeon-head="ssr"/>');
    expect(result.head).not.toContain('og:locale:alternate" content="x');
    expect(result.head?.match(/og:locale:alternate/g)).toHaveLength(1);
    const explicit = await (render as SsrRender)(pageIn('en', { props: { heads: [{ openGraph: { locale: 'en_GB' } }] } }), { appUrl: APP_URL });
    expect(explicit.head).toContain('property="og:locale" content="en_GB"');
  });

  it('gives a page that is not localized nothing, whatever its URL or locale says', async () => {
    for (const url of ['/about?locale=de', '/de-x/about', '/de/about']) {
      const result = await (render as SsrRender)({ component: 'seo/Heads', props: { heads: [{ openGraph: { siteName: 'Shop' } }] }, url, locale: 'de' }, { appUrl: APP_URL });
      expect(result.head).not.toContain('hreflang');
      expect(result.head).not.toContain('canonical');
      expect(result.head).not.toContain('og:locale');
    }
  });

  it('keeps every address on APP_URL: a path that names another host is dropped, and the request is not asked', async () => {
    const onWarning = vi.fn();
    const result = await (render as SsrRender)(
      pageIn('en', { alternates: { en: '//evil.example/en', de: '/de', 'x-default': '/' }, url: 'https://evil.example/en' }),
      { appUrl: APP_URL, onWarning },
    );
    expect(result.head).not.toContain('evil.example');
    expect(result.head).not.toContain('hreflang');
  });

  it('names all the languages or none: one failing address takes the others with it', async () => {
    const result = await (render as SsrRender)(pageIn('en', { alternates: { en: '/en', de: 'http://[bad', 'x-default': '/' } }), { appUrl: APP_URL });
    expect(result.head).not.toContain('hreflang');
    expect(result.head).not.toContain('canonical');
  });

  it('says once, not per language, that there is no APP_URL', async () => {
    const onWarning = vi.fn();
    const result = await (render as SsrRender)(pageIn('en'), { onWarning });
    expect(result.head).not.toContain('hreflang');
    expect(onWarning.mock.calls.filter(([message]) => String(message).includes('APP_URL'))).toHaveLength(1);
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
