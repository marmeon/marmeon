# Content Security Policy

## Introduction

A Content Security Policy tells the browser which scripts, styles and other resources a page may use. When an attacker manages to
put a `<script>` into a page, through a comment field that escapes too little, the policy keeps the browser from running it.
`contentSecurityPolicy()` of `@marmeon/http` sends such a policy with every document the app renders. Every new app turns it on in
`bootstrap/app.ts`:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, securityHeaders } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy()],
  },
});
```

The policy is opt-in: an app without the middleware sends none. Development runs under the same policy as production, with Vite,
its hot updates and the devtools included, so a violation shows on your machine before it reaches a server.

## The default policy

Without options, every document gets this header, with a new nonce each time:

```text
Content-Security-Policy: script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'self'
```

- **`script-src 'nonce-…' 'strict-dynamic'`.** A script runs only when it carries this response's nonce, and so do the scripts it
  loads. The entry's chunks load that way. An injected `<script>` has no nonce, and neither has an `onclick` attribute.
- **`object-src 'none'`.** No plugins.
- **`base-uri 'self'`.** No `<base>` that points the page's relative URLs at another site.

Styles, images, fonts and connections are not limited by default. Add the directives your app needs.

`DEFAULT_CSP` from `@marmeon/http` is this policy as a frozen object of directives. A directive you name replaces the default of
the same name, so you extend one from it: `scriptSrc: [...DEFAULT_CSP.scriptSrc!, 'https://cdn.example.com']` keeps the nonce and
`'strict-dynamic'`. The object is read-only; copy it, never change it.

## The nonce

Each response that renders a document gets its own nonce: 16 random bytes, made only when a document is rendered. The server puts
it everywhere the framework writes a script or a style:

- on the script, style and preload tags of `index.html`, through the `marmeon()` Vite plugin,
- on the `modulepreload` tags the server adds for the page's chunks (a preload without the nonce is blocked),
- on the scripts and styles React streams into a page,
- on the scripts and styles of `<Head>`, also those the browser adds to the head (it takes the nonce from the page),
- on the scripts of the development document, such as the devtools' bar and Vite's error overlay.

HTML your controller writes itself takes the nonce from `ctx.nonce()`:

```ts title="modules/notes/controllers/ShowNoteEmbedController.ts"
import { html } from '@marmeon/core';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteEmbedController extends Controller {
  handle(ctx: HttpContext) {
    return html`<!doctype html><title>Note</title><div id="note"></div><script nonce="${ctx.nonce()}" src="/embed.js"></script>`;
  }
}
```

The page data travels in a `<script type="application/json">`, which the browser never runs, so it needs no nonce. A JSON visit,
an island, an action and an API answer make no nonce at all.

A service outside `ctx` that needs the nonce takes `RequestNonce` from `@marmeon/http` as a constructor parameter and reads its
`value`: the nonce of this response, the one `ctx.nonce()` returns. Such a service is [scoped](container.md#scopes), because the
nonce belongs to one request.

## Adding directives

`contentSecurityPolicy(options)` takes the directives camel-cased. A new directive joins the defaults. A directive you name
replaces the default of the same name, so a `scriptSrc` of your own must list `NONCE` and `"'strict-dynamic'"` again. Without
them, the scripts the server allows by their nonce, such as the ones React streams into a page, are blocked. `false` leaves a
default out:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, NONCE, securityHeaders } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [
      securityHeaders(),
      contentSecurityPolicy({
        styleSrc: ["'self'", NONCE],
        imgSrc: ["'self'", 'data:', 'https://images.example.com'],
        frameAncestors: ["'none'"],
      }),
    ],
  },
});
```

| Value | Becomes |
| --- | --- |
| A list of sources | The directive with its sources, written as in the header: `"'self'"`, `'https://cdn.example.com'`. |
| `NONCE` | This response's nonce, `'nonce-…'`, in any directive. |
| `true` | A directive without sources, such as `upgradeInsecureRequests: true`. |
| `false` | The directive is left out, such as `baseUri: false`. |

The directives are `defaultSrc`, `scriptSrc`, `scriptSrcElem`, `scriptSrcAttr`, `styleSrc`, `styleSrcElem`, `styleSrcAttr`,
`imgSrc`, `fontSrc`, `connectSrc`, `mediaSrc`, `objectSrc`, `frameSrc`, `childSrc`, `workerSrc`, `manifestSrc`, `baseUri`,
`formAction`, `frameAncestors`, `sandbox`, `reportUri`, `reportTo`, `requireTrustedTypesFor`, `trustedTypes` and
`upgradeInsecureRequests`. A source with `;`, `,` or a line break throws when the app starts, since it would end the directive.

### Reporting first

A stricter policy can break a page you forgot. `reportOnly: true` sends `Content-Security-Policy-Report-Only` instead: the browser
blocks nothing and reports what it would have blocked, to the address of `reportUri` or `reportTo`:

```ts
contentSecurityPolicy({ styleSrc: ["'self'"], reportOnly: true, reportUri: ['/csp-reports'] });
```

The app needs a route that accepts the reports. Switch `reportOnly` off once the reports stay empty.

## Styles

The framework renders no `style` attribute, so `styleSrc: ["'self'"]` blocks nothing of the framework's in a built app. Under
`marmeon dev`, Vite adds `<style>` elements, which need `NONCE` in `styleSrc`, as in the example above. A `style` prop of your own
becomes an attribute, which a nonce does not cover: write classes instead. The
[styling](styling.md#a-strict-policy-for-styles) page shows how.

## Which responses get the policy

Only documents get the header: responses whose `Content-Type` is `text/html` or `application/xhtml+xml`. A response that brings a
policy of its own keeps it:

- the devtools' pages and the development error page, which allow their own inline code by its hash,
- the mail previews,
- a file served from a disk, which goes out with `sandbox`.

The [`devOnly()`](routing.md#development-only-routes) guard of your own development routes is not one of them: a page behind it
still gets the policy of `contentSecurityPolicy()`, and the guard adds `X-Frame-Options: SAMEORIGIN` unless the answer has one; a `frame-ancestors` in your policy takes precedence.

## Pages in a shared cache

A nonce must be secret to work. A page that a CDN or another shared cache keeps, through `Cache-Control: public` or `s-maxage`,
would hand the same nonce to every visitor, and a script injected into the page could read it and reuse it. When such a page
carries a nonce, the app logs a warning once per path. Keep pages with a nonce private, or give a cached page a policy without
`NONCE`, such as `scriptSrc: ["'self'"]`, which works only for pages without inline scripts.

## The other security headers

`securityHeaders()` from `@marmeon/http`, which a new app lists next to the policy, adds three headers to every response, pages, API answers, redirects and 404s alike:

| Header | Effect |
| --- | --- |
| `X-Content-Type-Options: nosniff` | The browser takes the declared type, and never runs a file as a script that was not sent as one. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Other sites learn your origin from a link, never the path and query. |
| `X-Frame-Options: DENY` | No page, not even one of your own, can show your pages in a frame. This stops clickjacking. |

A route that sets its own `X-Frame-Options` or `Referrer-Policy` keeps it, so a page made for embedding can say `SAMEORIGIN`. This
holds for a response passed through from elsewhere too, as long as the value is a valid one (`DENY` or `SAMEORIGIN`; known
referrer policies only). A value a browser would ignore, such as `ALLOW-FROM …`, `ALLOWALL` or an empty one, is replaced by the
configured value. Where the Content-Security-Policy sets `frame-ancestors`, as in the web app and the website, it decides for
documents, and a `SAMEORIGIN` from a route changes nothing there. `nosniff` and `Strict-Transport-Security` always follow the configuration: no route can weaken them. The options change or leave out the
other two:

```ts
securityHeaders({ frameOptions: 'SAMEORIGIN', referrerPolicy: 'same-origin' });
securityHeaders({ frameOptions: false }); // none
```

With `frameOptions: false`, only `frameAncestors` of the policy protects against framing, and it covers HTML documents alone: SVG, PDF
and XML answers then have no protection against framing.

`Strict-Transport-Security` is off by default. To turn it on, pass `hsts`:

```ts title="bootstrap/app.ts"
securityHeaders({ hsts: { maxAge: { days: 365 }, includeSubDomains: true } });
```

With it, browsers refuse plain HTTP for your host for a year, and with `includeSubDomains` for every subdomain too. Turn it on
only once all of them answer over HTTPS: a browser that has seen the header cannot reach an HTTP-only part any more.
The header goes out only on HTTPS responses (behind a proxy: `SERVER_TRUSTED_PROXIES`). A proxy that terminates TLS can send it instead.
`maxAge` is a [`Duration`](time.md#spans-of-time) of whole seconds (`{ days: 365 }`); a number means seconds. To withdraw HSTS, send `maxAge: 0` for a while: browsers that have seen the header then forget it (not together with `preload`). `preload` asks for the browsers' preload lists and needs `includeSubDomains` and a
`maxAge` of at least 31536000, a year; `securityHeaders()` throws a `TypeError` for anything else when the app starts.

## Testing

A test asserts the header like any other:

```ts title="modules/notes/csp.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('sends a policy with a nonce', async () => {
  const app = await createTestApp(application);
  const response = await app.get('/', { headers: { accept: 'text/html' } }).assertOk();
  expect(response.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
});
```
