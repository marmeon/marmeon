# Contributing to BespokeCore

Thank you for helping. This page covers the rules for a contribution — the sign-off, the checks, changesets — and how a
release is made. The principles the framework is built on are in the [README](README.md#principles); every package documents
itself in its README.

## Sign your commits off (DCO)

BespokeCore takes contributions under the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO), as the
Linux kernel and Node.js do — no contributor licence agreement. With the sign-off you certify that you wrote the change or have
the right to submit it under the project's licence (MIT, `LICENSE`; copyright BespokeCode). Every commit of a pull
request carries a `Signed-off-by` line with your real name and the e-mail of the commit:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

`git commit -s` adds it (`git commit --amend -s --no-edit` for the last commit, `git rebase --signoff main` for a whole branch).
A check on every pull request (the DCO app) refuses commits without it. The text you certify:

```text
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Set up

Node 26.10 or newer and pnpm 12 (the version in `packageManager` — `pnpm self-update` or Corepack-free `npm i -g pnpm@12.9.0`).

```sh
pnpm install
docker compose up -d   # Postgres, Redis and S3 for test:pgsql, test:redis and test:s3 (this repository's containers only)
pnpm dev               # the web app (apps/web-app) on http://localhost:3000 — first its .env and database (apps/web-app/README.md)
```

## Before you open a pull request

```sh
pnpm run ci            # every check CI runs: build, typecheck, lint, the test suites, sizes, types, docs, tarballs, image, release
```

`pnpm ci` without `run` is pnpm's own clean install — it checks nothing. The run has 14 parts (`pnpm run ci --list`; the
[README](README.md#the-repository) names them); some of them: `pnpm run ci --only test,lint`. `pack:smoke` and `image` need the
package store, the registry and Docker — without them they are reported as skipped, which is not green.

- **Tests** come with the change — type guarantees as `@ts-expect-error` tests, behaviour in Vitest, a feature shown in
  `apps/web-app` (principle 9).
- **The bundle-size limits only go down** (`packages/react/size-budget.json`) — raising one is the maintainers' decision (tab
  sync raised them once, by exactly its cost, E149).
- **A change an app can notice** gets an entry in [UPGRADING.md](UPGRADING.md) — impact, before → after, the way back — and a
  changeset (next section).
- Code, comments and commit messages are in English; a commit subject says what the change does, in the imperative.

## Changesets and releases

The framework is released in lockstep (E152): every `@bespokecore/*` package, the meta package `bespokecore` and
`create-bespoke-app` always have the same version — one `fixed` group in `.changeset/config.json`.

```sh
pnpm changeset         # pick any package and the bump; the fixed group carries the others along
```

- **0.x:** `minor` for a breaking change, `patch` for everything else. A `major` changeset would jump to 1.0.0 — `pnpm run ci`
  (`scripts/check-changesets.ts`) refuses it below 1.0.0. 1.0 comes after the reference app.
- **How a release happens** (`.github/workflows/release.yml`): on every push to `main`, the Changesets action opens or updates
  the *Version packages* pull request (`changeset version`: the versions, the changelogs). Merging it runs the checks again and
  **stages** every package that is not on npm yet — `pnpm stage publish -r` with trusted publishing (OIDC, no token in the
  repository) and provenance. Nothing is public until a maintainer approves the staged versions on npmjs.com with two-factor
  authentication; then `changeset git-tag` tags the release. The trusted-publisher configuration on npm allows staging only.
- Packages are packed and published with **pnpm** only — `npm publish` ignores `publishConfig.exports` and would ship the
  `@bespokecore/source` condition (`pnpm pack:check` proves the tarballs).
- A broken version is never unpublished; it is deprecated (`npm deprecate 'bespokecore@0.2.1' 'Broken: use 0.2.2'`, for every
  package of the release) and fixed by the next patch.
- `scripts/npm-trust.sh` is generated (`node scripts/npm-trust.ts`) — the `npm trust github` call for every package, run once by
  a maintainer after the first publish.

## Reporting a vulnerability

Never in a public issue — see [SECURITY.md](SECURITY.md).
