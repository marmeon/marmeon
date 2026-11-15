# Marmeon — notes for coding agents

TypeScript full-stack framework, pnpm monorepo (Node ≥ 26.10, `.nvmrc`). [CONTRIBUTING.md](CONTRIBUTING.md) is the full
rulebook — read only the section a task touches, not the whole file.

## Layout

- `packages/<name>/src` — the framework (`core`, `http`, `database`, `auth`, `react`, …); tests sit next to the code.
- `apps/web-app` shows every feature, `apps/blank-app` is the minimal app, `apps/website` serves `docs/*.md`.
- `scripts/` — the repository's checks (`ci.ts`, `check-source.ts`, …).

## Commands

```sh
pnpm test packages/<name>             # one package — the default while working
pnpm test path/to/file.test.ts        # one file
pnpm run ci --only typecheck,lint     # before handing work back
pnpm check:source                     # the repository rules below
pnpm run ci                           # everything CI runs; `pnpm ci` without `run` is a clean install, not a check
```

Postgres/Redis suites (`pnpm test:pgsql`, `pnpm test:redis`) need `docker compose up -d --wait <service>` and never run at
the same time — they share their databases.

## Rules that fail CI

- **Tests come with the change**: behaviour in Vitest, type guarantees as `@ts-expect-error` tests, a feature shown in
  `apps/web-app`. Temporary directories via `tempDir('marmeon-…')`; a test that leaves one behind turns the run red.
- **`check:source`**: no decision numbers, wave or step ids, personal dates or paths to private notes in any tracked file;
  `NODE_ENV` is checked positively (`=== 'development' || === 'test'`, or `environment.isDevelopment()`), never
  `!== 'production'` and never `import.meta.env.DEV`; no Valibot import outside `packages/*/src`; no comparisons with other
  frameworks in docs, stubs or messages. Details: CONTRIBUTING.md › "Rules over the source".
- **Bundle sizes are reported, not limited**: the `size` check lists them against the base commit in the job summary; a maintainer weighs each pull request's growth.
- **Public API, env default or command changed** → its page under `docs/` in the same commit; a change an app can notice
  a breaking change → its entry in `UPGRADING.md`, written when the release is prepared (`pnpm release:prepare`); say in the PR
  description what an app has to do.
- **Pull requests**: one change, the title in commit-subject style (it becomes the release note), exactly one release label
  (`breaking`/`feature`/`fix`/`docs`/`internal`, set by a maintainer). No changelog entries, no CHANGELOG edits.
  Details: CONTRIBUTING.md › "Pull requests and releases".
- English everywhere; commit subjects in the imperative, saying what the change does.

## Comments

Say what the code cannot: JSDoc on exported API (one or two sentences, link `docs/…` for more), the *why* where code
looks wrong. No history ("used to", "after the review"), no narration of the next line. Security invariants may be
shortened, never deleted. Details: CONTRIBUTING.md › "Comments".

## Design defaults

Security-correct beats familiar. In the data layer, failures an app must handle are `Result`s, not throws. Prefer the
existing pattern of the neighbouring package over a new abstraction.

## Review guidelines

For a reviewer, human or agent. Report verified defects only, most severe first, each with path, line and the fix.

Check on every changed symbol, docs paragraph, test and error path:

- **Fail open**: a missing binding, unknown case, thrown error or skipped check lets a request through instead of refusing.
- **Order and bypass**: another route, a global middleware, another entry point (API, island, prefetch, form post, HEAD) or
  a misordered stack skips a check, or a check runs before the state it relies on exists.
- **Side effects past the gate**: events, logs, cache entries, session keys or cookies written outside the place the design
  routes them through; anything shared between two users, guards or tenants that should not be.
- **Identity by name**: `constructor.name`, string tags or message text where class identity, a symbol or a registry is
  needed (bundlers rename).
- **A type promises more than run time delivers**: a union, `as`, a wide variable, an explicit generic or a JS caller lets
  a call compile that then throws or misbehaves.
- **Start errors**: a boot refusal has no false positives (an exact form or proof, no heuristic).
- **Docs say more or less than the code**: every claim of a changed paragraph, JSDoc or message checked against the code;
  pages, lists and error rows elsewhere that the change made wrong; a titled code block that cannot be copied.
- **A test does not prove its name**: it would pass without the change, it lacks the state the danger needs, or it asserts
  only an absence on a response body (an error body passes that too).
- **Siblings**: a defect found in one place is looked for in every sibling the change touches.

Never suggest: an absolute URL for a docs link in code or JSDoc (code names `docs/<page>.md#<anchor>`; only package
READMEs link https://marmeon.com/docs/…), a changelog entry or version bump, retrying a test, or a comment that tells
history.

By path:

- `packages/*/src`: security first (input reaching SQL, HTML, headers, paths, redirects; timing-safe comparisons; secrets
  in logs or errors), then races and ordering. Strings an app developer reads speak to that developer. An import of
  `kysely` belongs in `packages/database/src` only, `@marmeon/<name>/internal` in `packages/*/src` only.
- Tests: the root of an app whose modules take migrations from the repository's fixtures comes from
  `workspaceTempDir('marmeon-…')`. Postgres and Redis suites share their databases, so a test matches its own marker.
  Prefer counting work over measuring time.
- `docs/`: address the reader as "you", present tense, active voice, one idea per sentence; links to other pages are
  relative (`routing.md#route-model-binding`). Details: CONTRIBUTING.md › "Writing documentation".
- `packages/*/README.md`: a card for npm — one sentence, the install line, one short example, links to the website, the
  licence line.
- `packages/*/api.md`: generated by `pnpm api:update`; flag only an internal helper that became exported or a changed
  signature that breaks an app. A changed existing line needs `api-compatible` next to the release label, or `breaking`.
- `packages/*/stubs`, the starter's template, `apps/`: apps copy this code. It validates with `rules` of
  `@marmeon/validation`, decides access with `everyone` or a check, imports nothing internal, and stays small.
