# Marmeon docs

The documentation of Marmeon — the pages under `docs/` in ten sections, and the policies at the root (`UPGRADING.md`,
`CONTRIBUTING.md`, `SECURITY.md`) — as a normal Marmeon app, not a static export: server-rendered React pages in a layout,
`<Link prefetch>` between them, a search route on the server. Every page is `/docs/<slug>`. Deployed as an image behind Caddy
([below](#deployment)).

```sh
pnpm docs:dev      # from the repository root: http://localhost:3970 (writes .env with a fresh APP_KEY the first time)
pnpm docs:check    # marmeon build, the production server on a free port, a smoke test — part of `pnpm run ci`
pnpm docs:image    # the image: built from this checkout, checked, run read-only and behind Caddy — part of the `image` part
```

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
  comes before an example that only calls it.
- **Every page is written.** A page still to be written would carry the line `<!-- docs:pending -->`, which the app strips and
  marks "draft" in the navigation; no `docs/*.md` carries it any more, and `pnpm check:source` refuses it.
- **The text speaks to app developers.** `pnpm check:source` rule 5 refuses decision numbers and comparisons with another
  framework in the pages, the package READMEs, the root's README and the three policies (`UPGRADING.md` among them), and wave
  references in the pages, the READMEs and `UPGRADING.md` (not in CONTRIBUTING, which names the Gegenproben's paths). It reads
  the starter's template and the packages' stubs, which every new app copies, and the apps' READMEs and `.env` files for all of
  these and a personal date too. Rule 6
  reads the strings of the packages' code and launchers — messages, solutions, command output — for a decision number, a wave
  or another framework; comments stay the maintainers'.
- **The start page** (`/`) is the app's own (`views/Home.tsx`): what Marmeon is, where to start, every section with its pages.
  The root `README.md` is no page — a link to it stays code text.
- **`modules/docs/DocsRepository.ts`** reads, renders (markdown-it, CommonMark + GFM tables; raw HTML stays text; GitHub's heading
  anchors via github-slugger; code highlighted by Shiki on the server — one Shiki per process) and indexes the pages when the app
  boots — again when one changes under `marmeon dev`. An app singleton without request data, and the route binder of
  `/docs/:page` (`DocBinding`).
- **Pages** are a tree of elements, not HTML: links to other pages become `<Link prefetch>`, links to source files code text. A
  code block names its file with `title="…"` in its info string (```` ```ts title="modules/notes/routes.ts" ````): a caption
  above the block.
- **Routes** live in a middleware group of their own (`docs`): no session, no CSRF, no cookies; answers are `Cache-Control: public`
  with an `ETag` (`no-cache` in development) and a `Vary` that keeps the document and its JSON apart.
- **Content-Security-Policy:** `script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` on every document —
  **no nonce**, because the pages are cached publicly and a nonce (one per response) must never reach a shared cache. The pages
  need none: the server renders no inline script (the page object is inert JSON, nothing streams, code blocks are spans), and the
  entry, its chunks and tab sync's chunk come from `/assets/`. The links test checks every page for inline scripts and handlers.
  In development (`no-cache`, nothing shared) Vite's client, React Refresh and the devtools' bar are inline: the strict nonce
  policy there.
- **Headers:** `modules/docs/middleware/SecurityHeaders.ts`, global like the policy (so the 404 has them too): `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` — the same for everybody, so cacheable.
  `Strict-Transport-Security` comes from Caddy (`deploy/docs/Caddyfile`). `pnpm docs:check` and `pnpm docs:image` check `nosniff`
  on the pages they fetch.
- **Tests:** `modules/docs/links.test.ts` renders every page on the server and checks every link and anchor, that no page
  runs an inline script, and that a page names only files that exist (a link to a README is "no such page", a link to a
  directory fails) — and that every `docs/<page>.md#<anchor>` the framework's code, every package's stubs, the starter's
  template, the apps, the package READMEs and the root README name (the READMEs by their GitHub URL) leads to a page and its
  anchor (a path to a package README fails, and so does an anchor GitHub cannot make or, outside the READMEs, a page without
  one). `styles.test.ts` reads the stylesheet's phone layout: the menu is an overlay that scrolls.
  `search.test.ts` checks the search's order. `docs.test.ts` checks the sections and their pages, previous and next, the start
  page, the search, caching, the policy and the headers, cookies, the 404 (also for `/packages/…`) and the boot checks.

Settings (`config/docs.ts`): `DOCS_SOURCE` (the repository, default `../..`; `/app/content` in the image),
`DOCS_CACHE_MAX_AGE` (300 s), `DOCS_SEARCH_PER_MINUTE` (120).

## Deployment

`apps/docs/Dockerfile` is the monorepo variant of what `marmeon make:docker` writes: built from the repository's root, it
installs the workspace, builds the packages and the docs, then `pnpm deploy --prod` takes the docs app alone — its `files` (no
tests, no `.env`), its production dependencies, the framework's packages with their `dist/` (their manifests keep the
workspace's `exports` with the source condition — `marmeon` sets it only inside the workspace, so the copies run `dist/`) — and
the discovery manifest is written for exactly these packages. `marmeon build` runs without a key or any other secret; PID 1 of
the image is `tini` (signals, orphans). The pages are copied into `/app/content`: a new version of the docs is
a new image. `node:26-slim`, `USER node`, `NODE_ENV=production`, the root file system may be read-only (only `storage/` — the
rate limit's cache and the compile cache — is written). `apps/docs/Dockerfile.dockerignore` keeps every `.env`, `node_modules`,
the builds and the other apps' code out of the build context.

```sh
docker build -f apps/docs/Dockerfile -t marmeon-docs .    # from the repository's root
```

`deploy/docs/compose.yaml` runs it behind Caddy on one server: Caddy gets the certificate for `DOCS_DOMAIN`, speaks HTTP/1.1, 2
and 3, sets `Strict-Transport-Security` and compresses the pages (they carry no secret — an app's pages would, BREACH); it sets
`X-Forwarded-*` itself and drops a client's. The docs trust them from the Compose network's two subnets only (`TRUSTED_PROXIES`,
IPv4 and IPv6 — with IPv6 on the network every visitor keeps their address for the search's rate limit), run read-only with a
`tmpfs` for `/tmp` and a `storage` volume, and Caddy waits for them to be healthy. Next to the file, a `.env` holds `DOCS_DOMAIN`
and `APP_KEY` (never committed); then `docker compose up -d --build` — `DOCS_TAG=$(git rev-parse --short HEAD)` names the build,
and an older tag still on the machine starts again without one (the way back). The guide for a server — firewall, DNS, updates,
rollback — is [deployment](../../docs/deployment.md#one-server-with-compose) for any app; the steps for this one live with the
maintainers.
