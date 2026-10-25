import type { ImageSource } from '@marmeon/http/page';
import { useContext, type ImgHTMLAttributes, type ReactElement } from 'react';
import { HeadContext, IslandHeadContext } from './head.tsx';

type ImageAttributes = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'alt' | 'width' | 'height' | 'loading' | 'fetchPriority'>;

/** What both forms of `<Image>` take: the description (`''` for a decorative image) and how it loads. */
interface ImageBase extends ImageAttributes {
  /** The image described for people who cannot see it; `''` marks a decorative one. */
  alt: string;
  /** Which width the browser picks from `srcset`; `100vw` when the image has a `srcset` and this is left out. */
  sizes?: string;
  /** The image above the fold: loaded at once, at high priority, and preloaded in the head of the first document. */
  priority?: boolean;
}

export type ImageProps = ImageBase &
  (
    | { src: ImageSource; width?: never; height?: never }
    // A plain URL has no size of its own, and without one the page shifts when the image arrives.
    | { src: string; width: number; height: number }
  );

/**
 * An image that does not shift the layout (width and height are always set), loads lazily and, given an `ImageSource`,
 * offers the browser several widths and formats. See docs/images.md#image.
 */
export function Image({ src, alt, sizes, priority, width, height, ...rest }: ImageProps) {
  const head = useContext(HeadContext);
  const island = useContext(IslandHeadContext);
  const source: ImageSource = typeof src === 'string' ? { src, width: width!, height: height! } : src;
  const hasSrcset = Boolean(source.srcset) || Boolean(source.sources?.length);
  const sizesAttribute = sizes ?? (hasSrcset ? '100vw' : undefined);

  if (priority) {
    if (island !== null) {
      // The head went out before an island rendered, and it is not reachable from there.
      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        console.warn(`[marmeon:R20] <Image priority> in island [${island}] — there is no preload from an island; the image still loads eagerly. Put the image on the page, or drop priority.`);
      }
    } else if (head.collector && !head.collector.sealed) {
      const preload = preloadTag(source, sizesAttribute, rest.crossOrigin, rest.referrerPolicy);
      if (preload) head.collector.entries.push({ tags: [preload] });
    }
  }

  const img = (
    <img
      decoding="async"
      {...rest}
      src={source.src}
      srcSet={source.srcset}
      sizes={source.srcset ? sizesAttribute : undefined}
      alt={alt}
      width={source.width}
      height={source.height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
    />
  );
  if (!source.sources?.length) return img;
  return (
    <picture>
      {source.sources.map(({ type, srcset }) => (
        <source key={type} type={type} srcSet={srcset} sizes={sizesAttribute} />
      ))}
      {img}
    </picture>
  );
}

/** `<link rel="preload" as="image">` (with the `<img>`'s `crossOrigin` and `referrerPolicy`, or the browser fetches twice) for the first source the browser may take (it skips a `type` it cannot decode), else the `<img>`. */
function preloadTag(source: ImageSource, sizes: string | undefined, crossOrigin: ImgHTMLAttributes<HTMLImageElement>['crossOrigin'], referrerPolicy: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy']): ReactElement | null {
  const first = source.sources?.[0];
  const srcset = first ? first.srcset : source.srcset;
  const urls = [source.src, ...(srcset ?? '').split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')].filter((url) => url !== '');
  // Only http(s) and relative URLs reach the head: a `javascript:` or `data:` URL from a prop is never preloaded.
  if (!urls.every(isPlainUrl)) return null;
  return <link rel="preload" as="image" href={source.src} imageSrcSet={srcset} imageSizes={srcset ? sizes : undefined} type={first?.type} crossOrigin={crossOrigin} referrerPolicy={referrerPolicy} fetchPriority="high" />;
}

function isPlainUrl(url: string): boolean {
  // Browsers drop tabs and line breaks inside a URL and leading control characters or spaces.
  let start = 0;
  while (start < url.length && url.charCodeAt(start) <= 0x20) start++;
  const bare = url.slice(start).replace(/[\t\n\r]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https';
}
