# Search Engines & Sharing

## Introduction

A search engine reads a page's title and description, and a chat app or social network reads its Open Graph and card tags to
draw a preview of a link. `<Head>` sets all of them from the page, next to the title. The server writes them into the first
document, which is the one crawlers and link previews read, and the browser keeps them current on every visit.

This page covers the fields of `<Head>`. The [pages](pages.md#the-document-head) page covers the title and the template around it.

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
