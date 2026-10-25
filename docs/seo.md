# Search Engines & Sharing

## Introduction

A search engine reads a page's title and description, and a chat app or social network reads its Open Graph and card tags to
draw a preview of a link. `<Head>` sets all of them from the page, next to the title. The server writes them into the first
document, which is the one crawlers and link previews read, and the browser keeps them current on every visit.

This page covers the fields of `<Head>` and the sitemap and `robots.txt`, which Marmeon writes from your routes. The [pages](pages.md#the-document-head) page covers the title and the template around it.

## The head's fields

```tsx title="modules/notes/views/Show.tsx"
<Head
  title={note.title}
  description={note.summary}
  canonical={`/notes/${note.id}`}
  openGraph={{ type: 'article', image: note.cover, article: { publishedTime: note.createdAt } }}
  twitter={{ card: 'summary_large_image' }}
/>
```

| Field         | Writes                                                          |
| ------------- | --------------------------------------------------------------- |
| `description` | `<meta name="description">`                                     |
| `canonical`   | `<link rel="canonical">`                                        |
| `robots`      | `<meta name="robots">`, from `index` and `follow`               |
| `openGraph`   | `og:*` as `property`, `article:*` for an article                |
| `twitter`     | `twitter:*` as `name`                                           |
| `jsonLd`      | `<script type="application/ld+json">`, see [Structured data](#structured-data) |

`robots` says only what you set: `{ index: false }` writes `noindex`, and `{ index: false, follow: true }` writes
`noindex, follow`. A crawler treats a missing part as allowed.

`openGraph` takes `title`, `description`, `type` (`'website'`, `'article'` or `'profile'`), `url`, `siteName`, `locale`,
`image` (a URL, or `{ url, width, height, alt }`) and `article` (`publishedTime`, `modifiedTime`, `authors`, `tags`).
`twitter` takes `card` (`'summary'` or `'summary_large_image'`; a layout sets it once), `site`, `creator`, `title`, `description`, `image` and
`imageAlt`.

`openGraph.url` has no default: set it, or leave it out (`canonical` is a separate field). `openGraph.article.authors` are written as
given, so pass what the preview should show, such as a profile URL. `twitter` takes the page's title and description when it
sets none of its own, and not those of `openGraph`.

### Layouts and pages

A layout and its page may both set fields. The page wins, the same rule as for the title:

- A simple field (`description`, `canonical`) is the one of the last `<Head>` that sets it.
- `openGraph`, `twitter` and `robots` merge key by key. A layout sets `openGraph={{ siteName: 'Notes' }}`, a page sets
  `openGraph={{ title: note.title }}`, and the head carries both.

When `openGraph` or `twitter` is set at all, its `title` and `description` default to the page's `title` (as written, without
the title template) and `description`. A page that sets neither object gets no `og:` or `twitter:` tags.

### Absolute URLs

A preview needs a full address. `canonical`, `openGraph.url`, `openGraph.image` and `twitter.image` may be relative, and are
made absolute:

- On the server against `APP_URL`, never against the request's `Host` or `X-Forwarded-Host`. Anybody can send a request with
  such a header, and a cache that kept the answer would hand every crawler an address on a foreign domain.
- In the browser against the origin of `APP_URL`, which the server writes once into the first document (a `<meta>`; it is no secret and visits do not carry it), so the head after hydration equals the server's. Without `APP_URL`, against `location.origin`.

A path stays on the app's own origin: `//other.example/x` and `/\other.example/x` name another host and are left out, while a full `https://cdn.example/x.png` keeps its host. Without `APP_URL`, a relative URL is left out. A URL with another scheme than `http:` or `https:`, such as `javascript:` or
`data:`, is left out as well, and development logs a warning for each.

## Structured data

`jsonLd` writes [schema.org](https://schema.org) data for search engines as `<script type="application/ld+json">`. Pass one block or an array:

```tsx title="modules/notes/views/Show.tsx"
<Head
  title={note.title}
  jsonLd={{
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: note.title,
    datePublished: note.createdAt,
    author: { '@type': 'Person', name: note.author.name },
  }}
/>
```

A block is plain JSON with an `@type`. The type `JsonLd` refuses a `Date`, a function and `undefined`, so write a date as its ISO string.
A layout and its page both contribute: the blocks of every `<Head>` are written in render order, so a layout can say
`{ '@type': 'Organization', … }` and the page its article. They do not replace each other.

Text from your users is safe in a block. The server writes the JSON with every `<` escaped (`\u003c`), so a name such as
`</script><script>…` can neither end the script early nor open a comment, and the block parses back to exactly the object you
passed. In the browser the block is set as the element's text, so no HTML parser reads it. Do not put the JSON in a `<script>`
child of `<Head>` yourself: React escapes it and the block would no longer be JSON.

The block carries the response's [CSP nonce](csp.md) like the server's other scripts. The nonce is not what protects it, because a data block
never runs and `script-src` does not govern it. The escaping does.

A block that `JSON.stringify` cannot write (a cycle, a `bigint`) is a bug in the app: development throws an error that names the
block's `@type`, and production leaves the block out.

Under `require-trusted-types-for 'script'` a browser refuses to set a script's text. The browser then removes the block
instead of writing it, and development logs a warning. The first document, as the server sent it, still has the block, and crawlers read that one.

## Pages in several languages

A page on a [localized route](localization.md#the-locale-in-the-url) names all its languages by itself, and you write nothing for
it. Its head carries one `<link rel="alternate" hreflang>` per locale of the app, and `x-default`, the address without a locale
that redirects to the visitor's:

```html
<link rel="canonical" href="https://notes.example/de/about">
<link rel="alternate" hreflang="en" href="https://notes.example/en/about">
<link rel="alternate" hreflang="de" href="https://notes.example/de/about">
<link rel="alternate" hreflang="x-default" href="https://notes.example/about">
```

- `canonical` is the page's own address in its own language, unless a `<Head canonical>` says otherwise. The addresses in the head
  have no query string, because a query often only tracks (`?utm_source=…`). A page whose query selects its content (`?page=2`)
  sets its own `canonical`. The `alternates` of the page object, which a language switcher reads, keep the query.
- With `openGraph` set, `og:locale` is the page's locale in Open Graph's form (`de-AT` becomes `de_AT`) unless `openGraph.locale` is
  set, and `og:locale:alternate` names each other locale.
- The addresses are made absolute like the others (see [Absolute URLs](#absolute-urls)): from `APP_URL`, never from the request. Without
  `APP_URL` the whole block (the languages and the default `canonical`) is left out, and development says so once.
- The browser updates them on every visit, also from one language to another.

They come only from the server: the route is localized, so its page object carries `alternates`. A page on another route gets none,
whatever its URL looks like, and an app that does not use `localized()` has no `hreflang` at all.

## Sitemap and robots.txt

Mark a route with `.sitemap()` and it appears in `/sitemap.xml`:

```ts title="modules/about/routes.ts"
export default defineRoutes((Route) => {
  const about = Route.authorize(everyone).name('about.');

  about.get('/about', ShowAboutController).name('index').sitemap();
  about.get('/about/features/:feature{[a-z-]+}', ShowFeatureController).name('features.show').sitemap();
});
```

The file is made when a crawler asks, from the routes the app loaded at start. Nothing is generated at build time, because a
`<loc>` needs the address of the app (`APP_URL`) and a page of a record needs the database. A route without parameters is one
entry. A route with parameters says which pages it has in a `sitemap()` method of its controller:

```ts title="modules/about/controllers/ShowFeatureController.ts"
import { Controller, type SitemapEntries } from '@marmeon/http';

export class ShowFeatureController extends Controller {
  // …

  sitemap(): SitemapEntries<{ feature: string }> {
    return this.#catalog.all().map((feature) => ({
      params: { feature: feature.slug },
      lastModified: new Date(feature.updatedAt),
    }));
  }
}
```

`sitemap()` returns a list, a generator (`async *sitemap()` reads a large table in batches), or a promise of a list. Each entry
is `{ params, lastModified? }`: `params` fills the path of the route, and `lastModified` becomes `<lastmod>` as a `YYYY-MM-DD`
date. The controller is built in a scope of its own, so it may take services in its constructor. A route without parameters may
have the method too, to say when its page changed: the latest date it gives is the one that counts. A closure cannot have it.

The address of each entry is built from the route's path, with every value encoded, and from `APP_URL`, never from the `Host`
header of the request. An entry the route would answer with a 404 is left out, with one warning in the log for the route: a
value the constraint refuses, a missing parameter, a dot segment (`..`), a value with a slash (unless the constraint allows one). The sitemap never names a URL that
does not work. The file escapes `& < > " '`.

`/robots.txt` has three lines and names the sitemap:

```text
User-agent: *
Disallow: /_marmeon/

Sitemap: https://example.com/sitemap.xml
```

It has no `Disallow` for anything else. A `Disallow` keeps no one out and tells every reader where something is. Protect a page
with [authorization](authorization.md), and leave it out of the sitemap by not marking it. Both endpoints exist only when a route
carries `.sitemap()`. A route of your own on `/sitemap.xml` or `/robots.txt` wins, so an app that needs other rules writes its own
`robots.txt` as a route. So does a catch-all route that is not localized, such as `/:page{.+}`: it takes both paths and the
endpoints never answer.

A route under `Route.localized()` appears once per language. Its hook (or the path itself) names the page, not the language, so
`sitemap()` returns entries without `locale`; the app writes one `<url>` for each locale the app supports (`APP_LOCALES`), in the spelling of its
URL. Each `<url>` lists all versions as `<xhtml:link rel="alternate" hreflang="…">`, and `x-default` for the address without a
language, which redirects to the visitor's. A page with two languages and three features is six `<url>` elements with three links
each; the file declares `xmlns:xhtml` when it holds any. See [Routes under a locale](routing.md#routes-under-a-locale).

The start stops, with code H10, when a marked route:

- is not a `GET` route, is `.internal()`, or belongs to the `api` group;
- sits behind a middleware that adds `user` (`authenticate()`), or does not say `authorize(everyone)` (a policy or a check of
  your own): a sitemap lists pages anyone can open;
- has parameters but no `sitemap()` method on its controller;

or when `APP_URL` is not set to an `http` or `https` address.

The endpoints run behind the global middleware only, so a request has no session and no cookie, and the answer says
`Cache-Control: public, max-age=300`. The sitemap is made once for requests that arrive together, and kept in the process for
five minutes; a failing `sitemap()` is reported once, and for 30 seconds the app does not call it again: it serves the last file it made, or
answers `503` with `Retry-After`. The endpoints send no cookie, whatever a global middleware sets. A
file lists at most 50 000 URLs (the limit of the format); each language of a localized page counts as one, and an entry whose versions do not all fit is left out whole. The rest is left out, and the log says so.
