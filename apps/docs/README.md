# BespokeCore docs

The repository's READMEs — `README.md` and every `packages/*/README.md` — as a normal BespokeCore app (E114, E133: no static
export): server-rendered React pages in a layout, `<Link prefetch>` between them, a search route on the server. Not published
(E10 is open); hosting is an ordinary Node deployment.

```sh
pnpm docs:dev      # from the repository root: http://localhost:3970 (writes .env with a fresh APP_KEY the first time)
pnpm docs:check    # bespoke build, the production server on a free port, a smoke test — part of `pnpm run ci`
```

- **`docs.config.ts`** puts every package in one group of the navigation, typed against the package names. The start fails when
  a package has no entry or no README (`DocsError`).
- **`modules/docs/DocsRepository.ts`** reads, renders (markdown-it, CommonMark + GFM tables; raw HTML stays text; GitHub's heading
  anchors via github-slugger; code highlighted by Shiki on the server) and indexes the READMEs when the app boots — again when one
  changes under `bespoke dev`. An app singleton without request data, and the route binder of `/packages/:name`.
- **Pages** are a tree of elements, not HTML: links to other READMEs become `<Link prefetch>`, links to source files code text.
- **Routes** live in a middleware group of their own (`docs`): no session, no CSRF, no cookies; answers are `Cache-Control: public`
  with an `ETag` (`no-cache` in development) and a `Vary` that keeps the document and its JSON apart.
- **Tests:** `modules/docs/links.test.ts` renders every page on the server and checks every link and anchor; `docs.test.ts` the
  search, caching, cookies, the 404 and the boot checks.

Settings (`config/docs.ts`): `DOCS_SOURCE` (the repository, default `../..`), `DOCS_CACHE_MAX_AGE` (300 s),
`DOCS_SEARCH_PER_MINUTE` (120).
