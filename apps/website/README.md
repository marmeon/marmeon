# Marmeon docs

The documentation of Marmeon — the pages under `docs/` in ten sections, and the policies at the root (`UPGRADING.md`,
`CONTRIBUTING.md`, `SECURITY.md`) — as a normal Marmeon app, not a static export: server-rendered React pages in a layout,
`<Link prefetch>` between them, a search route on the server. Every page is `/docs/<slug>`. Deployed as an image behind Caddy
([below](#deployment)).

```sh
pnpm website:dev      # from the repository root: http://localhost:3970 (writes .env with a fresh APP_KEY the first time)
pnpm website:check    # marmeon build, the production server on a free port, a smoke test — part of `pnpm run ci`
pnpm website:image    # the image: built from this checkout, checked, run read-only and behind Caddy — part of the `image` part
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
  marks "draft" in the navigation; `pnpm check:source` refuses it in `docs/`.
- **The text speaks to app developers.** `pnpm check:source` rule 5 refuses comparisons with another framework in the pages,
  the package READMEs, the root's README, the three policies, the starter's template, the packages' stubs and the apps' READMEs
  and `.env` files; rule 7 refuses decision numbers, wave references, personal dates and paths into the maintainers' notes in
  every tracked file. Rule 6 reads the strings of the packages' code and launchers — messages, solutions, command output — for a
  decision number, a wave or another framework.
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
  `Strict-Transport-Security` comes from Caddy (`deploy/website/Caddyfile`). `pnpm website:check` and `pnpm website:image` check `nosniff`
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

`apps/website/Dockerfile` is the monorepo variant of what `marmeon make:docker` writes: built from the repository's root, it
installs the workspace, builds the packages and the docs, then `pnpm deploy --prod` takes the docs app alone — its `files` (no
tests, no `.env`), its production dependencies, the framework's packages with their `dist/` (their manifests keep the
workspace's `exports` with the source condition — `marmeon` sets it only inside the workspace, so the copies run `dist/`) — and
the discovery manifest is written for exactly these packages. `marmeon build` runs without a key or any other secret; PID 1 of
the image is `tini` (signals, orphans). The pages are copied into `/app/content`: a new version of the docs is
a new image. `node:26-slim`, `USER node`, `NODE_ENV=production`, the root file system may be read-only (only `storage/` — the
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
and `APP_KEY` (never committed); then `docker compose up -d --build` — `WEBSITE_TAG=$(git rev-parse --short HEAD)` names the build,
and an older tag still on the machine starts again without one (the way back). The guide for a server — firewall, DNS, updates,
rollback — is [deployment](../../docs/deployment.md#one-server-with-compose).
