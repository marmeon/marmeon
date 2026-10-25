# Images

## Introduction

An image that arrives late moves the text around it, and an image that loads before it is seen slows the page down. `<Image>` from
`@marmeon/react` writes the markup that avoids both: the image's size is always set, it loads lazily unless you say otherwise, and
an image that exists in several widths and formats lets the browser pick one.

## `<Image>`

```tsx title="modules/about/views/Index.tsx"
import { Image } from '@marmeon/react';
import banner from '../images/banner.svg';

<Image src={banner} width={320} height={80} alt="Two lines of text beside a square" />;
```

A plain URL needs `width` and `height`: the browser reserves that space before the file arrives, so the page does not shift. Both
are the file's own size in pixels; CSS may scale the image, and the ratio is kept. `alt` is required. Write `alt=""` for an image
that only decorates, so a screen reader skips it. Leaving `alt` or a plain URL's size out is a type error.

`<Image>` takes the other attributes of `<img>` (`className`, `style`, `title`, …), except `srcSet`, `loading` and `fetchPriority`:
the image decides those from its source and `priority`. It loads with `loading="lazy" decoding="async"`.

## Widths and formats

An `ImageSource` is the image as plain JSON: its `src`, `width` and `height`, and optionally the widths it exists in (`srcset`) and
the same image in newer formats (`sources`, best first):

```ts
import type { ImageSource } from '@marmeon/http/page';

const hero: ImageSource = {
  src: '/media/hero-1280.jpg',
  width: 1280,
  height: 720,
  srcset: '/media/hero-640.jpg 640w, /media/hero-1280.jpg 1280w',
  sources: [{ type: 'image/avif', srcset: '/media/hero-640.avif 640w, /media/hero-1280.avif 1280w' }],
};
```

```tsx
<Image src={hero} alt="The harbour at dawn" />
```

With `sources`, `<Image>` writes a `<picture>` with one `<source>` for each format and the `<img>` inside as the fallback. The
browser takes the first format it can decode.

## `sizes`

With a `srcset` the browser has to know how wide the image will be, before layout, to pick a file. `sizes` says so, as a media
condition list: `sizes="(min-width: 60rem) 50vw, 100vw"` is half the viewport on wide screens and all of it on narrow ones. Left out,
it is `100vw`, which is right for an image that spans the page and picks too large a file for anything smaller.

## `priority`

The image above the fold, such as a hero, should not wait to be lazy:

```tsx
<Image src={hero} alt="The harbour at dawn" priority />
```

`priority` writes `loading="eager"` and `fetchpriority="high"`. When the server renders the page, it also puts
`<link rel="preload" as="image">` into the head of the document, for the first format that has a `type` (a browser skips a type it
cannot decode), or for the `<img>` without formats, so the file starts loading before the markup is parsed. The preload takes the image's `crossOrigin` and `referrerPolicy`.
Only URLs that are relative or start with `http:` or `https:` are preloaded in the head. For a plain `<img>` (no formats), React also
writes a preload of its own at the start of the body; the browser fetches the file once.

The preload belongs to the first document. A visit by navigation has no new document, and the image is part of the page it brings.
Use `priority` for one or two images per page, since each one competes with the rest for the first bytes.

An island has no access to the head. `<Image priority>` in an island still loads eagerly, but cannot preload; in development it logs
`[marmeon:R20]` (see [errors](errors.md#error-codes)). Put the image on the page instead.

## Images of the app

An image that is part of the app, like a hero or a logo as a photo, is built in several widths and formats when you import it with
`?image`:

```tsx title="modules/about/views/Index.tsx"
import hero from '../images/hero.jpg?image';

<Image src={hero} alt="The harbour at dawn" sizes="(min-width: 60rem) 50vw, 100vw" />;
```

The import is an `ImageSource`, so `<Image>` takes it as it is, with its size already set. The build writes each width in AVIF, WebP
and the file's own format into `assets/`; the name carries a hash of the content, so a file is cached for good and the client and
the server build agree on every URL. The widths are `640`, `960`, `1280`, `1920` and `2560`, but none above the original's: a
1000 px wide photo is built at 640 and 960, a 300 px wide one at 300. The `<img>` in the `<picture>` is the largest width of the
original format.

The work is done by [sharp](https://sharp.pixelplumbing.com), which an app installs itself and only when it imports an image with
`?image`:

```sh
pnpm add -D sharp
```

Without it, a build with such an import stops and says so. Change widths, formats and quality in `vite.config.ts`:

```ts
marmeon({ images: { widths: [480, 960, 1440], formats: ['webp'], quality: 80 } });
```

| Option | Default | Effect |
| --- | --- | --- |
| `widths` | `[640, 960, 1280, 1920, 2560]` | The widths to build, in pixels. |
| `formats` | `['avif', 'webp']` | The formats next to the original's. |
| `quality` | `70` | Quality of the lossy formats, 1 to 100. |

A build writes each variant once: the result is kept in `node_modules/.cache/marmeon-images/`, keyed by the file's content and
these options, so the next build, on your machine or on a CI that keeps the folder, encodes only what changed.

In development nothing is resized. The import is the original with its own size, so the page looks the same and starts at once.
The widths and formats appear in a build (`marmeon build`).

Only the app's own files are read: `.jpg`, `.jpeg`, `.png`, `.webp` and `.avif` inside the app that the dev server's `server.fs`
rules allow. A file outside the app, a URL, a GIF and an SVG are refused, and an SVG needs no resizing: import it without `?image`.
The file's first bytes must say it is a JPEG, PNG, WebP or AVIF, whatever its name says. The URLs of the variants are written into
the code, so `base` in `vite.config.ts` has to be absolute (`/` or a URL), not `./`. A picture of more than 50 million pixels stops the build and names the file, because its decoding would take gigabytes of memory.
Add `"@marmeon/vite/client"` to `compilerOptions.types` for the type of `*?image`.

## Images from the server

A controller can send an `ImageSource` as a prop, for example for an image a user uploaded and the app resized:

```ts
return this.view('articles/Show', { article, cover: { src: article.coverUrl, width: 1200, height: 630 } satisfies ImageSource });
```

The form stays the same when you generate it differently, so a page does not change when the sizes come from somewhere else. The
framework does not resize images: `<Image>` writes the files you name.
