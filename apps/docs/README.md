# Marmeon docs

The repository's READMEs — `README.md` and every `packages/*/README.md` — and its guides — `docs/*.md` and the policies at the
root (`UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`) — as a normal Marmeon app (E114, E133: no static export):
server-rendered React pages in a layout, `<Link prefetch>` between them, a search route on the server. Deployed as an image
behind Caddy (E142, [below](#deployment)).

```sh
pnpm docs:dev      # from the repository root: http://localhost:3970 (writes .env with a fresh APP_KEY the first time)
pnpm docs:check    # marmeon build, the production server on a free port, a smoke test — part of `pnpm run ci`
pnpm docs:image    # the image: built from this checkout, checked, run read-only and behind Caddy — part of the `image` part
```

- **`docs.config.ts`** puts every package in one group of the navigation, typed against the package names, and lists the
  guides (`/guides/<slug>`, the navigation's first group). The start fails when a package has no entry or no README, when a
  `docs/*.md` has no entry, or when a listed guide is gone (`DocsError`). `UPGRADING.md` is marked `changes: true`: its sections
  come after every other hit of the search.
- **`modules/docs/DocsRepository.ts`** reads, renders (markdown-it, CommonMark + GFM tables; raw HTML stays text; GitHub's heading
  anchors via github-slugger; code highlighted by Shiki on the server — one Shiki per process) and indexes the pages when the app
  boots — again when one changes under `marmeon dev`. An app singleton without request data, and the route binder of
  `/packages/:name` (`GuideBinding` binds `/guides/:guide`).
- **Pages** are a tree of elements, not HTML: links to other READMEs and guides become `<Link prefetch>`, links to source files
  code text.
- **Routes** live in a middleware group of their own (`docs`): no session, no CSRF, no cookies; answers are `Cache-Control: public`
  with an `ETag` (`no-cache` in development) and a `Vary` that keeps the document and its JSON apart.
- **Content-Security-Policy:** `script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` on every document —
  **no nonce**, because the pages are cached publicly and a nonce (one per response, E147) must never reach a shared cache. The
  pages need none: the server renders no inline script (the page object is inert JSON, nothing streams, code blocks are spans),
  and the entry, its chunks and tab sync's chunk come from `/assets/`. The links test checks every page for inline scripts and
  handlers. In development (`no-cache`, nothing shared) Vite's client, React Refresh and the devtools' bar are inline: the strict
  nonce policy there.
- **Headers:** `modules/docs/middleware/SecurityHeaders.ts`, global like the policy (so the 404 has them too): `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` — the same for everybody, so cacheable.
  `Strict-Transport-Security` comes from Caddy (`deploy/docs/Caddyfile`). `pnpm docs:check` and `pnpm docs:image` check `nosniff`
  on the pages they fetch.
- **Tests:** `modules/docs/links.test.ts` renders every page on the server and checks every link and anchor and that no page runs
  an inline script; `docs.test.ts` the guides, the search, caching, the policy and the headers, cookies, the 404 and the boot
  checks.

Settings (`config/docs.ts`): `DOCS_SOURCE` (the repository, default `../..`; `/app/content` in the image),
`DOCS_CACHE_MAX_AGE` (300 s), `DOCS_SEARCH_PER_MINUTE` (120).

## Deployment

`apps/docs/Dockerfile` is the monorepo variant of what `marmeon make:docker` writes (E141): built from the repository's root, it
installs the workspace, builds the packages and the docs, then `pnpm deploy --prod` takes the docs app alone — its `files` (no
tests, no `.env`), its production dependencies, the framework's packages with their `dist/` (their manifests keep the
workspace's `exports` with the source condition — `marmeon` sets it only inside the workspace, E187, so the copies run `dist/`) — and
the discovery manifest is written for exactly these packages (E160). `marmeon build` runs without a key or any other secret (E187);
PID 1 of the image is `tini` (signals, orphans). The READMEs and guides are copied into `/app/content`: a new version of the
docs is a new image. `node:26-slim`, `USER node`, `NODE_ENV=production`, the root file system may be read-only (only `storage/` —
the rate limit's cache and the compile cache — is written). `apps/docs/Dockerfile.dockerignore` keeps every `.env`, `node_modules`,
the builds and the other apps' code out of the build context.

```sh
docker build -f apps/docs/Dockerfile -t marmeon-docs .    # from the repository's root: ≈ 300 MB, node_modules 58 MB
```

`deploy/docs/compose.yaml` runs it behind Caddy on one server (Hetzner Cloud, E142): Caddy gets the certificate for `DOCS_DOMAIN`,
speaks HTTP/1.1, 2 and 3, sets `Strict-Transport-Security` and compresses the pages (they carry no secret — an app's pages would,
BREACH); it sets `X-Forwarded-*` itself and drops a client's. The docs trust them from the Compose network's two subnets only
(`TRUSTED_PROXIES`, IPv4 and IPv6 — with IPv6 on the network every visitor keeps their address for the search's rate limit),
run read-only with a `tmpfs` for `/tmp` and a `storage` volume, and Caddy waits for them to be healthy.
Next to the file, a `.env` holds `DOCS_DOMAIN` and `APP_KEY` (never committed); then `docker compose up -d --build` —
`DOCS_TAG=$(git rev-parse --short HEAD)` names the build, and an older tag still on the machine starts again without one (the way
back). The guide for
the server — firewall, DNS, updates, rollback — is [docs/deployment.md](../../docs/deployment.md) for any app; the steps for this
one live with the maintainers.
