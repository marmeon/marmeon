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

Node 26.10 or newer and pnpm 12 (the version in `packageManager` — `pnpm self-update` or Corepack-free `npm i -g pnpm@12.9.1`).

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
  sync raised them once, by exactly its cost, E149; Wave 9 reset every limit once to its measured size + 0.5 KB, E186). A saving
  lowers a limit to the new size + 0.5 KB (`BESPOKE_SIZE_BUDGET=update pnpm test packages/react`, `… pnpm size`); extra cost eats
  that reserve, which is never refilled.
- **Tests leave nothing behind:** every run gets its own temporary directory (`TMPDIR`), and `pnpm test` fails with a list when a
  test leaves a `bespoke-*` entry in it. Make temporary directories with `tempDir('bespoke-…')` (`scripts/test/temp-dir.js`): it
  removes them when the test, or the file, is done.
- **A measure comes with its Gegenproben** (next section).
- **A change an app can notice** gets an entry in [UPGRADING.md](UPGRADING.md) — impact, before → after, the way back — and a
  changeset ([Changesets and releases](#changesets-and-releases)).
- Code, comments and commit messages are in English; a commit subject says what the change does, in the imperative.

## Gegenproben

A test that passes proves little until it fails without the thing it tests. A *Gegenprobe* (counter-check) takes a measure out —
a patch — and shows the test turning red **for the measure's reason**. They live in the repository, one file per step of a wave
(`scripts/gegen/w9/s04-live.ts`, E188), and run with `pnpm gegen` — never as part of `pnpm run ci` (they patch the working tree;
`scripts/ci.test.ts` keeps them out):

```sh
pnpm gegen --list                 # waves, steps, cases
pnpm gegen w9/s04                 # one step: every case must be red, for its reason
pnpm gegen w9/s04 G1 G2           # some cases
pnpm gegen w9                     # the whole wave, in step order
pnpm gegen w9 --control           # without the patches: every case must be green
pnpm gegen w9 --repo <checkout>   # against another checkout (a fresh git worktree)
pnpm gegen w9/s04 G1 --verbose    # print every run's output
```

### The format

A step's file default-exports `defineGegenproben({ step, cases })` (`scripts/gegen/define.ts` checks it when it loads: unique ids, a
reason for every red case, pairs that exist, patches inside the repository). A case names its patches, its run and its reason — a
real one, from `scripts/gegen/w9/s04-live.ts`:

```ts
import { defineGegenproben } from '../define.ts';

const HUB = 'packages/live/src/hub.ts';
const SESSION_LIMIT = { file: HUB, find: '    if ((this.#sessions.get(request.scope)?.size ?? 0) >= this.#perSession) {', replace: '    if (false) {' };

export default defineGegenproben({
  step: 'W9.4',
  cases: [
    {
      id: 'G1',
      title: 'no limit per session: the 17th stream of one session opens (200 instead of 429)',
      patch: [SESSION_LIMIT],
      run: { vitest: 'packages/live/src/live.test.ts', name: 'holds at most LIVE_MAX_STREAMS_PER_SESSION streams of one session' },
      expect: /expected 200 to be 429/,
      masks: 'G2',                                       // its masking pair: the atomic count (G2), each red on its own
    },
    // { id: 'G1c', …, expectGreen: true }              — a masking probe: one measure alone still holds
    // { id: 'G9', …, run: { command: ['pnpm', 'run', 'ci', '--only', 'pack:check'] }, expect: /orphaned/ }   — a command instead of Vitest
  ],
});
```

- **`patch`** — `{ file, find, replace }`, relative to the repository's root; `dist/` files too (after `pnpm build` — what
  `pack:smoke` packs). Each `find` must occur exactly once (after the case's earlier patches of the same file), or nothing is
  patched. A case's patches are applied all or none and taken back in reverse order — also on Ctrl-C; afterwards every file has its
  old hash and `git status` is unchanged, or the runner stops (exit 3).
- **`run`** — `{ vitest: file(s), name }` runs the repository's `pnpm test` with the name as a filter: plain text, the runner escapes
  it for `-t` (a regular expression); Vitest matches it against the full name, the describes joined with ` > `
  (`'its budget (E75: a ratchet) > core'`). Or `{ command: [...] }`: any command in the root, exit 0 is green. Both take `env` and a
  `timeout` (default 10 minutes).
- **`expect`** — the reason, matched against the failures' messages (the lines before the stack) or the command's output — not a
  matcher's name: Vitest says *expected 1 to be 2*, not `toBe`, and shortens long values with "…" (cut the reason to their start, or
  give the assertion a message of its own: `expect(problem, problem)`).

### Reading the result

Each case ends as one of: **red** (the reason matches) · **GREEN** — the measure has no effect, or the test does not test it · **red
for another reason** — does not count · **0 tests** — the name matched nothing (never red, never green) · **anchor problem** — a
`find` that is missing or not unique. The summary counts "n of m red (the reason matches), k masking probes as expected"; the exit code
is 0 when every case is as expected, 1 when one is not, 2 for a usage error, 3 when the working tree could not be put back exactly
(stop and look: `git status`), 130/143 after Ctrl-C/SIGTERM (the patches are taken back first).

- **Masking:** two measures that hide each other (a session lock and a cookie lock, a projection and a props filter) get a scenario
  each — `masks: 'G2'` pairs them, and both must be red on their own; a masking probe (`expectGreen: true`) shows that one measure
  alone still covers the case, and is counted apart.
- **The control** (`--control`) runs every case without its patch: all green, or the Gegenprobe proves nothing.
- **`--repo <checkout>`** patches and runs another checkout — the acceptance of a wave runs the whole wave in a fresh `git worktree`
  (no `.env`, `storage/` or `.bespoke/`), with and without `--control`.
- **Anchors age:** a later change can move a case's `find`; the anchor check says which, before anything is written. A case red for
  another (correct) reason after a later step — read the message, then correct the reason, never just count "red".
- Never edit the repository while `pnpm gegen` runs, and never run it beside `pnpm test:pgsql`/`test:redis` (shared databases).

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
