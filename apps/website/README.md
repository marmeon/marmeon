# Marmeon website

The website of Marmeon: the landing page (`modules/site`) at `/` and the documentation (`modules/docs`) under `/docs` — the
pages in `docs/` in ten sections and the policies at the root (`UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`). It is a
normal Marmeon app, not a static export: server-rendered React pages in a layout, `<Link prefetch>` between them, a search
route on the server. The start page is `/docs`, every page `/docs/<slug>` and the search `/docs/search` — so `search` is a
reserved slug. Deployed as an image behind Caddy ([below](#deployment)).

The imprint (`/imprint`) and the privacy policy (`/privacy`) are Markdown files in `content/legal/`: edit the text there, no code
change needed. They are read at boot (a missing file stops the start), are no pages of the docs (not in its navigation or
search) and ship in the image through `files` in `package.json`.

```sh
pnpm website:dev      # from the repository root: http://localhost:3970 (writes .env with a fresh APP_KEY the first time)
pnpm website:check    # marmeon build, the production server on a free port, a smoke test — part of `pnpm run ci`
pnpm website:image    # the image: built from this checkout, checked, run read-only and behind Caddy — part of the `image` part
```

- **Layouts**: `layouts/DocsLayout.tsx` for the `docs/*` pages, `layouts/SiteLayout.tsx` (skip link, header with the version
  badge, footer) for the landing page and the error pages; `bootstrap/layouts.ts` picks by page name. The shared pieces — mark,
  wordmark, version badge, copy button, terminal, code block — live in `modules/site/components`. The copy button renders only
  in the browser, so a page without JavaScript carries none.
- **`docs.config.ts`** lists the sections and their pages, in reading order: a slug (`/docs/<slug>`), the label in the
  navigation, and the file — `docs/<slug>.md`, or a policy at the root via `file`. Previous and next lead through every page of
  every section in this order. There are no package pages: the package READMEs are short cards for npm that link here, and
  `/packages/…` is a 404.
- **The boot checks** stop the start (`DocsError`, every problem listed) when a slug is not lower-case words with dashes or is
  listed twice, when a file is listed twice, lies elsewhere or is gone, when a page names the root `README.md`, and when a
  `docs/*.md` has no entry in a section.
  `UPGRADING.md` is marked `changes: true`: its sections come after every other hit of the search.
- **The search** (`modules/docs/search.ts`, a route on the server) finds the sections that have every word of the query. The
  page's name weighs most, then the heading — also a heading of the words of a name the section uses, `onOneServer` under "One
  server only" — then how often the prose has the word, and last whether a code block uses it: a section that explains a word
  comes before an example that only calls it. The page lists the hits grouped by page, each with its navigation section, and
  works as a plain GET form without JavaScript.
- **Every page is written.** A page still to be written would carry the line `<!-- docs:pending -->`, which the app strips and
  marks "draft" in the navigation; `pnpm check:source` refuses it in `docs/`.
- **The text speaks to app developers.** `pnpm check:source` rule 5 refuses comparisons with another framework in the pages,
  the package READMEs, the root's README, the three policies, the starter's template, the packages' stubs and the apps' READMEs
  and `.env` files; rule 7 refuses decision numbers, wave references, personal dates and paths into the maintainers' notes in
  every tracked file. Rule 6 reads the strings of the packages' code and launchers — messages, solutions, command output — for a
  decision number, a wave or another framework.
- **The landing** (`/`, `modules/site`) is the app's own: the hero, the seven principles and "one type, end to end" (`views/Landing.tsx`).
  Its code lives in `modules/site/snippets.ts` — files of the notes example the docs build up, so keep them in step with the API.
  `SiteSnippets` highlights them once at boot with the docs' Shiki and theme (the browser gets markup, no highlighter), and the
  controller hands them to the page. `modules/site` owns the `public` group, the answers' headers and the Content-Security-Policy;
  the version of the framework it shows comes from `@marmeon/core`'s manifest (shared once as `site.version`).
- **The docs' start page** (`/docs`) is the app's own (`views/Home.tsx`): what Marmeon is, where to start, every section with its pages.
  The root `README.md` is no page — a link to it stays code text.
- **`modules/docs/DocsRepository.ts`** reads, renders (markdown-it, CommonMark + GFM tables; raw HTML stays text; GitHub's heading
  anchors via github-slugger; code highlighted by Shiki on the server — one Shiki per process — with the `marmeon` theme in `shiki-theme.ts`: one placeholder colour per role, turned into a class by `highlight.ts`; the colours live in `styles/code.css`) and indexes the pages when the app
  boots — again when one changes under `marmeon dev`. An app singleton without request data, and the route binder of
  `/docs/:page` (`DocBinding`).
- **Pages** are a tree of elements, not HTML: links to other pages become `<Link prefetch>`, links to source files code text. A
  code block names its file with `title="…"` in its info string (```` ```ts title="modules/notes/routes.ts" ````): a caption
  above the block.
- **Markdown for tools:** every page is also served at `/docs/<slug>.md` (`text/markdown; charset=utf-8`, `Link: <…/docs/<slug>>; rel="canonical"`),
  and its HTML page names it with `<link rel="alternate" type="text/markdown">`. The route comes before `/docs/:page` and takes
  only `[a-z0-9-]+.md`; it answers from what the boot read, never from the file system. Links are rewritten where they would
  break: a link to a page becomes its `.md` sibling (`../UPGRADING.md` → `upgrading.md`), a link to a file that is no page
  (`README.md#principles`) points to GitHub; a `docs/*.md` file whose links are all siblings is served byte for byte. The
  rewrite needs the exact place of each link, so a scanner finds them and the boot checks it against markdown-it: a link the two
  read differently (a reference link, an image inside a link) stops the start — write links inline. Absolute URLs come from
  `APP_URL` (`modules/site/public-url.ts`), never from the request's host: the answers are cached publicly.
- **Routes** live in the `public` middleware group (`modules/site`): no session, no CSRF, no cookies; answers are `Cache-Control: public`
  with an `ETag` (`no-cache` in development) and a `Vary` that keeps the document and its JSON apart. The docs' routes add
  the navigation as route middleware (`ShareNavigation`); the landing does not carry it. `DocsLayout` renders it twice: a sidebar beside the page and, on a phone, a `<details>` menu above it; the section of the current page is open on the server, and both work without JavaScript. `/` focuses the search field.
- **Content-Security-Policy:** `script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'` on every document —
  **no nonce**, because the pages are cached publicly and a nonce (one per response) must never reach a shared cache. The pages
  need none: the server renders no inline script (the page object is inert JSON, nothing streams, code blocks are spans), and the
  entry, its chunks and tab sync's chunk come from `/assets/`. `style-src 'self'` allows stylesheets from `/assets/` only (fonts and the
  favicon come from there too, under `font-src` and `img-src`, which stay open): no `style` attribute (not in SVG either), no inline `<style>`, no CSS-in-JS. The links test checks every page for inline
  scripts, handlers and `style` attributes.
  **Analytics:** with `SITE_FATHOM_SITE` set (a Fathom site id; anything but uppercase letters and digits stops the boot) and in production
  only, every document — landing, docs, 404 — carries Fathom's external script in its head (`bootstrap/ssr.tsx`, handed the id by
  `ShareAnalytics`; not a `<Head>`, so the client router never reloads it; every pageview, the first included, is sent by `Pageviews` (`data-auto="false"`; Fathom's `data-spa` mode cannot see the Navigation API) with the page's address without query or hash — Fathom itself reads the address bar's query and sends `q`, so a page whose address has one (the docs search) is not counted) and
  `script-src` adds `https://cdn.usefathom.com/script.js`. The policy has no `default-src`, `img-src` or `connect-src`, so the beacon needs
  nothing else; its beacon image gets `img.style.position` through the CSSOM, which `style-src` does not govern. Without an id the page and the policy are the ones above.
  In development (`no-cache`, nothing shared) Vite's client, React Refresh and the devtools' bar are inline: the strict nonce
  policy there.
- **Styles** (`styles/`): `app.css` is the only entry (`index.html`) and only `@import`s the parts. `tokens.css` holds every
  colour, size, space and radius as a custom property — light by default, dark under `prefers-color-scheme` — and the fonts:
  Source Serif 4 (text, with its optical-size axis) and IBM Plex Mono (code, labels) from the `@fontsource` packages, which
  Vite bundles into `/assets/` (dev dependencies; the image needs none). `base.css` has the reset, links, buttons, focus ring and
  helpers. `favicon.svg` carries its own dark variant. `modules/site/contrast.test.ts` computes the WCAG contrast of the tokens
  in both themes.
- **Headers:** `modules/site/middleware/SecurityHeaders.ts`, global like the policy (so the 404 has them too): `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` — the same for everybody, so cacheable.
  `Strict-Transport-Security` comes from Caddy (`deploy/website/Caddyfile`). `pnpm website:check` and `pnpm website:image` check `nosniff`
  on the pages they fetch.
- **Tests:** `modules/docs/links.test.ts` renders every page on the server and checks every link and anchor, that no page
  runs an inline script, and that a page names only files that exist (a link to a README is "no such page", a link to a
  directory fails) — and that every `docs/<page>.md#<anchor>` the framework's code, every package's stubs, the starter's
  template, the apps, the package READMEs and the root README name (the READMEs by their GitHub URL) leads to a page and its
  anchor (a path to a package README fails, and so does an anchor GitHub cannot make or, outside the READMEs, a page without
  one). `styles.test.ts` reads the layout stylesheet: the phone menu is a panel that scrolls, and the side navigation and the menu are each shown at one breakpoint.
  `search.test.ts` checks the search's order. `modules/site/site.test.ts` checks the landing (server-rendered, public, no navigation, the
  version). `docs.test.ts` checks the sections and their pages, previous and next, the start
  page, the search, caching, the policy and the headers, cookies, the 404 (also for `/packages/…`) and the boot checks (the reserved slug included).

Settings: `config/docs.ts` has `DOCS_SOURCE` (the repository, default `../..`; `/app/content` in the image) and
`DOCS_SEARCH_PER_MINUTE` (120); `config/site.ts` has `SITE_CACHE_MAX_AGE` (300 s) and `SITE_FATHOM_SITE` (empty: no analytics).

## Deployment

`apps/website/Dockerfile` is the monorepo variant of what `marmeon make:docker` writes: built from the repository's root, it
installs the workspace, builds the packages and the docs, then `pnpm deploy --prod` takes the website alone — its `files` (no
tests, no `.env`), its production dependencies, the framework's packages with their `dist/` (their manifests keep the
workspace's `exports` with the source condition — `marmeon` sets it only inside the workspace, so the copies run `dist/`) — and
the discovery manifest is written for exactly these packages. `marmeon build` runs without a key or any other secret; PID 1 of
the image is `tini` (signals, orphans). The pages are copied into `/app/content`: a new version of the docs is
a new image; `/app/content` also holds `content/legal` (from `pnpm deploy`). `node:26-slim`, `USER node`, `NODE_ENV=production`, the root file system may be read-only (only `storage/` — the
rate limit's cache and the compile cache — is written). `apps/website/Dockerfile.dockerignore` keeps every `.env`, `node_modules`,
the builds and the other apps' code out of the build context.

```sh
docker build -f apps/website/Dockerfile -t marmeon-website .    # from the repository's root
```

`deploy/website/compose.yaml` runs it behind Caddy on one server: Caddy gets the certificate for `WEBSITE_DOMAIN`, speaks HTTP/1.1, 2
and 3, sets `Strict-Transport-Security` and compresses the pages (they carry no secret — an app's pages would, BREACH); it sets
`X-Forwarded-*` itself and drops a client's. The docs trust them from the Compose network's two subnets only (`TRUSTED_PROXIES`,
IPv4 and IPv6 — with IPv6 on the network every visitor keeps their address for the search's rate limit), run read-only with a
`tmpfs` for `/tmp` and a `storage` volume, and Caddy waits for them to be healthy. Next to the file, a `.env` holds `WEBSITE_DOMAIN`
(`marmeon.com`, the apex; the docs are under `/docs`), `WEBSITE_REDIRECT_DOMAINS` and `APP_KEY` (never committed); then `docker compose up -d --build` — `WEBSITE_TAG=$(git rev-parse --short HEAD)` names the build,
and an older tag still on the machine starts again without one (the way back). The guide for a server — firewall, DNS, updates,
rollback — is [deployment](../../docs/deployment.md#one-server-with-compose).

```sh
WEBSITE_DOMAIN=marmeon.com
WEBSITE_REDIRECT_DOMAINS=www.marmeon.com, marmeon.de, www.marmeon.de, marmeon.dev, www.marmeon.dev
```

Every host in `WEBSITE_REDIRECT_DOMAINS` (comma-separated Caddy addresses; empty or unset: none) gets its own certificate and
answers `301` to `https://$WEBSITE_DOMAIN` with path and query kept. The target is the configured domain, never the request's
`Host`, so it is no open redirect; HTTPS on the `.dev` hosts is mandatory (HSTS preload), which is why they need a certificate too.
DNS: an `A` and an `AAAA` record for each of the six names to the server, before the first start (Let's Encrypt validates over
ports 80 and 443).
