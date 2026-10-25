import type { ImageSource, SsrRender } from '@marmeon/http/page';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IslandHeadContext } from './head.tsx';
import { Image, type ImageProps } from './image.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

const photo: ImageSource = {
  src: '/img/photo-1280.jpg',
  width: 1280,
  height: 720,
  srcset: '/img/photo-640.jpg 640w, /img/photo-1280.jpg 1280w',
  sources: [
    { type: 'image/avif', srcset: '/img/photo-640.avif 640w, /img/photo-1280.avif 1280w' },
    { type: 'image/webp', srcset: '/img/photo-640.webp 640w, /img/photo-1280.webp 1280w' },
  ],
};

const markup = (props: ImageProps) => renderToStaticMarkup(<Image {...props} />);

describe('<Image>', () => {
  it('writes a plain URL with its size, lazily', () => {
    expect(markup({ src: '/logo.svg', width: 40, height: 20, alt: 'Logo' })).toBe('<img decoding="async" src="/logo.svg" alt="Logo" width="40" height="20" loading="lazy"/>');
  });

  it('keeps an empty description for a decorative image', () => {
    expect(markup({ src: '/dots.svg', width: 4, height: 4, alt: '' })).toContain('alt=""');
  });

  it('offers the widths of an image source, 100vw unless told otherwise', () => {
    const source = { src: '/a.jpg', width: 10, height: 5, srcset: '/a-5.jpg 5w, /a.jpg 10w' };
    const html = markup({ src: source, alt: 'A' });
    expect(html).toContain('srcSet="/a-5.jpg 5w, /a.jpg 10w"');
    expect(html).toContain('sizes="100vw"');
    expect(markup({ src: source, alt: 'A', sizes: '(min-width: 60rem) 50vw, 100vw' })).toContain('sizes="(min-width: 60rem) 50vw, 100vw"');
    expect(markup({ src: '/a.jpg', width: 10, height: 5, alt: 'A' })).not.toContain('sizes=');
  });

  it('wraps the formats in <picture>, the <img> last', () => {
    const html = markup({ src: photo, alt: 'A photo', className: 'hero' });
    expect(html.startsWith('<picture><source type="image/avif" srcSet="/img/photo-640.avif 640w, /img/photo-1280.avif 1280w" sizes="100vw"/>')).toBe(true);
    expect(html).toContain('<source type="image/webp"');
    expect(html.indexOf('<img')).toBeGreaterThan(html.lastIndexOf('<source'));
    expect(html.endsWith('/></picture>')).toBe(true);
    expect(html).toContain('class="hero"');
  });

  it('loads eagerly at high priority with `priority`', () => {
    const html = markup({ src: '/a.jpg', width: 10, height: 5, alt: 'A', priority: true });
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
  });
});

describe('<Image priority> in the head', () => {
  afterEach(() => vi.restoreAllMocks());

  function Page({ image, island }: { image: ImageSource | string; island?: boolean }) {
    const element = typeof image === 'string' ? <Image src={image} width={10} height={5} alt="A" priority /> : <Image src={image} alt="A" priority />;
    return island ? <IslandHeadContext.Provider value="hero">{element}</IslandHeadContext.Provider> : element;
  }
  const render = createSsrRenderer(resolveModulePages({ '/modules/x/views/Page.tsx': async () => ({ default: Page }) }), {});
  const headOf = async (image: ImageSource | string, island = false) =>
    (await (render as SsrRender)({ component: 'x/Page', props: { image, island }, url: '/' }, { appUrl: 'https://app.example' })).head ?? '';

  it('preloads the first format the browser may take, with its widths', async () => {
    const head = await headOf(photo);
    expect(head).toContain('<link rel="preload" as="image" href="/img/photo-1280.jpg" imageSrcSet="/img/photo-640.avif 640w, /img/photo-1280.avif 1280w" imageSizes="100vw" type="image/avif"');
    expect(head).toContain('fetchPriority="high"');
    expect(head).toContain('data-marmeon-head="ssr"');
  });

  it('gives the preload the crossOrigin and referrerPolicy of the image', async () => {
    const Cors = () => <Image src={photo} alt="A" priority crossOrigin="anonymous" referrerPolicy="no-referrer" />;
    const cors = createSsrRenderer(resolveModulePages({ '/modules/x/views/Cors.tsx': async () => ({ default: Cors }) }), {});
    const { head } = await (cors as SsrRender)({ component: 'x/Cors', props: {}, url: '/' }, { appUrl: 'https://app.example' });
    expect(head).toMatch(/<link rel="preload"[^>]*crossorigin="anonymous"/i);
    expect(head).toMatch(/<link rel="preload"[^>]*referrerpolicy="no-referrer"/i);
  });

  it('preloads the <img> without formats', async () => {
    const head = await headOf('/hero.jpg');
    expect(head).toContain('rel="preload" as="image" href="/hero.jpg"');
    expect(head).not.toContain('imageSrcSet');
  });

  it('never preloads a URL that is not http(s) or relative', async () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', ' java\tscript:alert(1)']) {
      expect(await headOf(src)).not.toContain('preload');
    }
    expect(await headOf({ ...photo, sources: [{ type: 'image/avif', srcset: 'data:image/avif;base64,AAAA 640w' }] })).not.toContain('preload');
    expect(await headOf('https://cdn.example/a.jpg')).toContain('href="https://cdn.example/a.jpg"');
  });

  it('has no preload from an island, and says so in development (R20)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await headOf(photo, true)).not.toContain('preload');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[marmeon:R20]'));
  });
});
