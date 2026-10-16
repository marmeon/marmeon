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
  `!== 'production'`; no Valibot import outside `packages/*/src`; no comparisons with other frameworks in docs, stubs or
  messages. Details: CONTRIBUTING.md › "Rules over the source".
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
