# create-bespoke-app

Creates a BespokeCore app: the starter kit — sign-in and registration, a layout, a home page, the devtools, oxlint and Vitest —
or a blank app. Node 26.10 or newer.

```sh
pnpm create bespoke-app my-app            # on a terminal it asks: the starter kit? Docker files? pnpm or npm? git?
pnpm create bespoke-app my-app --yes      # the defaults, nothing asked: the starter kit, pnpm, install, a first commit
npm init bespoke-app my-app -- --npm      # with npm: the flags after --
npx create-bespoke-app my-app --minimal   # a blank app
```

Then:

```sh
cd my-app
pnpm dev                                  # http://localhost:3000 — the server with Vite, a queue worker and the scheduler
```

Register an account: in development the mails go to the log (`MAIL_MAILER=log`), the confirmation link with them.

## Options

| Option | |
|---|---|
| `<dir>` | the new app's directory — it must not exist or be empty; its name becomes the package name (`My App` → `my-app`) and `APP_NAME` |
| `-y`, `--yes` | take the defaults, ask nothing |
| `--minimal` | a blank app: no auth module, no home page — exactly `apps/blank-app` of the repository |
| `--private-registration` | the starter kit's registration never tells whether an address has an account (`bespoke make:auth --private-registration`) |
| `--docker` | a Dockerfile, `.dockerignore` and `compose.production.yaml` (`bespoke make:docker`) — [deployment](../../docs/deployment.md) |
| `--npm`, `--pnpm` | the package manager — pnpm by default |
| `--no-install` | only the files: install yourself, then run the generators the output names |
| `--no-git` | no git repository |
| `-h`, `--help` · `-v`, `--version` | |

On a terminal a missing directory is asked for (also with `--yes`). Without a terminal (CI, a pipe) nothing is asked: the flags
and the defaults decide, and a missing directory ends the run with exit code 2 — `create-bespoke-app needs a directory:
create-bespoke-app <dir> [--yes]`. Every wrong call is exit code 2: an unknown flag, two directories, `--npm` with `--pnpm`,
`--private-registration` with `--minimal`. A failed step is exit code 1, with the output of the step; the directory stays as it
was then. A directory that is not empty, a missing pnpm and a Node older than 26.10 are exit code 1 before anything is written;
Ctrl+C at a question is 130.

### In the first day after a release

pnpm (11 and newer) installs no version that is younger than its `minimumReleaseAge` — one day by default, a guard against
packages that are pulled again soon after they appear. For a day after a release, `pnpm create bespoke-app` therefore either
falls back to an older `create-bespoke-app` (with the framework of its release) or stops — for the very first release there is
none — and an install of the new exact `@bespokecore/*` versions fails. Wait a day, or let only the framework through for this one command (the
variable reaches the install `create-bespoke-app` runs, and nothing else changes):

```sh
pnpm_config_minimum_release_age_exclude='["@bespokecore/*","bespokecore","create-bespoke-app"]' pnpm create bespoke-app my-app
```

npm has no such delay. `create-bespoke-app` never changes your pnpm settings.

## What it does

A thin shell around the framework's own generators (E150) — the app's code comes from one place:

1. **The template** — `template/base` is the repository's blank app (`apps/blank-app`, copied by `pnpm template:sync`): the
   `system` module, `bootstrap/`, `config/app.ts`, `middleware/SecurityHeaders.ts` with a strict Content-Security-Policy, the
   lint preset (`bespoke make:lint-config`), `vitest.config.ts`, a standalone `tsconfig.json`, `.env.example`, `.env.test` and
   the `storage/` skeleton. The starter kit adds `template/kit`: the home module (`/`, its page and its test).
2. **`package.json`** — every `@bespokecore/*` package at exactly this package's version (the framework is versioned in
   lockstep, E152), `@bespokecore/cli` among the `dependencies` (it runs on the server, E159), `packageManager: pnpm@12.9.0` —
   with `--npm` nothing of pnpm's. Next to it the app's `README.md`: its commands with the chosen package manager (production
   runs `bespoke queue:work --queue=mail,default` for the queued jobs and the auth module's mails).
3. **`.env`** — from `.env.example`, with a fresh `APP_KEY` (readable by its owner only, ignored by git); `.env.test` gets a test
   key of its own. The template never carries a key.
4. **Install**, then the app's `bespoke`: `make:auth` for the starter kit (sign-in, registration, password reset, e-mail
   verification, API tokens — the code is the app's; its layout `modules/auth/layouts/AppLayout.tsx` frames the home page too),
   `migrate` (`.env` says `NODE_ENV=development`: it writes the tables' types the build checks), `make:docker` with `--docker`.
   The install and the generators run without your shell's `NODE_ENV` — the app's `.env` decides (E170), so a shell that
   exports `NODE_ENV=production` changes nothing.
5. **git** — `git init` and a first commit, unless the directory is inside a repository already. Signing follows your git
   configuration; when the commit fails (a signing key that is not there), every file stays staged and the output says so.

It has no dependencies: the prompts are `node:readline`.

## For the framework's maintainers

`BESPOKE_CREATE_TARBALLS=<dir>` takes the framework from the tarballs of `pnpm pack` in that directory instead of the registry:
they are copied into the app's `vendor/bespokecore/`, every `@bespokecore/*` dependency points there (`file:`), the packages'
dependencies on each other too (`overrides` — in `pnpm-workspace.yaml` for pnpm, with nothing hoisted, in `package.json` for
npm; optional peers nobody installs by absolute path, since npm resolves a relative override from the dependent's directory).
That is how `pnpm pack:smoke` and `pnpm image:smoke` make their apps before anything is published. Not for apps; the variable never
reaches the install and the generators.

Changing the template: edit `apps/blank-app` and run `pnpm template:sync`; a test fails while the two differ.
