# Content Security Policy

## Introduction

A Content Security Policy tells the browser which scripts, styles and other resources a page may use. When an attacker manages to
put a `<script>` into a page, through a comment field that escapes too little, the policy keeps the browser from running it.
`contentSecurityPolicy()` of `@marmeon/http` sends such a policy with every document the app renders. Every new app turns it on in
`bootstrap/app.ts`:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [SecurityHeaders, contentSecurityPolicy()],
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

## The nonce

Each response that renders a document gets its own nonce: 16 random bytes, made only when a document is rendered. The server puts
it everywhere the framework writes a script or a style:

- on the script, style and preload tags of `index.html`, through the `marmeon()` Vite plugin,
- on the scripts and styles React streams into a page,
- on the scripts and styles of `<Head>`,
- on the scripts of the development document, such as the devtools' bar and Vite's error overlay.

HTML your controller writes itself takes the nonce from `ctx.nonce()`:

```ts title="modules/notes/controllers/ShowNoteEmbedController.ts"
import { html } from '@marmeon/core';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteEmbedController extends Controller {
  handle(ctx: HttpContext) {
    return String(html`<!doctype html><title>Note</title><div id="note"></div><script nonce="${ctx.nonce()}" src="/embed.js"></script>`);
  }
}
```

The page data travels in a `<script type="application/json">`, which the browser never runs, so it needs no nonce. A JSON visit,
an island, an action and an API answer make no nonce at all.

## Adding directives

`contentSecurityPolicy(options)` takes the directives camel-cased. A new directive joins the defaults. A directive you name
replaces the default of the same name, so a `scriptSrc` of your own must list `NONCE` and `"'strict-dynamic'"` again. Without
them, the scripts the server allows by their nonce, such as the ones React streams into a page, are blocked. `false` leaves a
default out:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, NONCE } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [
      SecurityHeaders,
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

## Pages in a shared cache

A nonce must be secret to work. A page that a CDN or another shared cache keeps, through `Cache-Control: public` or `s-maxage`,
would hand the same nonce to every visitor, and a script injected into the page could read it and reuse it. When such a page
carries a nonce, the app logs a warning once per path. Keep pages with a nonce private, or give a cached page a policy without
`NONCE`, such as `scriptSrc: ["'self'"]`, which works only for pages without inline scripts.

## The other security headers

A new app's `middleware/SecurityHeaders.ts` adds three headers to every response, pages, API answers, redirects and 404s alike:

| Header | Effect |
| --- | --- |
| `X-Content-Type-Options: nosniff` | The browser takes the declared type, and never runs a file as a script that was not sent as one. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Other sites learn your origin from a link, never the path and query. |
| `X-Frame-Options: DENY` | No page, not even one of your own, can show your pages in a frame. This stops clickjacking. |

The file also holds a switch for `Strict-Transport-Security`, `false` by default. To turn it on, set:

```ts title="middleware/SecurityHeaders.ts"
const HSTS: string | false = 'max-age=31536000; includeSubDomains';
```

With it, browsers refuse plain HTTP for your host for a year, and with `includeSubDomains` for every subdomain too. Turn it on
only once all of them answer over HTTPS: a browser that has seen the header cannot reach an HTTP-only part any more.
The header goes out only on HTTPS responses. A proxy that terminates TLS can send it instead.

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
