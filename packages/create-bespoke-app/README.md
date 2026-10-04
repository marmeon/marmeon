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

Without a terminal (CI, a pipe) nothing is asked: the flags and the defaults decide, and a missing directory ends the run with
exit code 2 — `create-bespoke-app needs a directory: create-bespoke-app <dir> [--yes]`. Every other failure is exit code 1, with
the output of the step that failed; the directory stays as it was then.

## What it does

A thin shell around the framework's own generators (E150) — the app's code comes from one place:

1. **The template** — `template/base` is the repository's blank app (`apps/blank-app`, copied by `pnpm template:sync`): the
   `system` module, `bootstrap/`, `config/app.ts`, `middleware/SecurityHeaders.ts` with a strict Content-Security-Policy, the
   lint preset (`bespoke make:lint-config`), `vitest.config.ts`, a standalone `tsconfig.json`, `.env.example`, `.env.test` and
   the `storage/` skeleton. The starter kit adds `template/kit`: the home module (`/`, its page and its test).
2. **`package.json`** — every `@bespokecore/*` package at exactly this package's version (the framework is versioned in
   lockstep), `packageManager` with pnpm 12 — with `--npm` nothing of pnpm's.
3. **`.env`** — from `.env.example`, with a fresh `APP_KEY` (readable by its owner only, ignored by git); `.env.test` gets a test
   key of its own. The template never carries a key.
4. **Install**, then the app's `bespoke`: `make:auth` for the starter kit (sign-in, registration, password reset, e-mail
   verification, API tokens — the code is the app's; its layout `modules/auth/layouts/AppLayout.tsx` frames the home page too),
   `migrate` (`.env` says `NODE_ENV=development`: it writes the tables' types the build checks), `make:docker` with `--docker`.
5. **git** — `git init` and a first commit, unless the directory is inside a repository already. Signing follows your git
   configuration; when the commit fails (a signing key that is not there), every file stays staged and the output says so.

It has no dependencies: the prompts are `node:readline`.

## For the framework's maintainers

`BESPOKE_CREATE_TARBALLS=<dir>` takes the framework from the tarballs of `pnpm pack` in that directory instead of the registry:
they are copied into the app's `vendor/bespokecore/`, every `@bespokecore/*` dependency points there (`file:`), the packages'
dependencies on each other too (`overrides` — in `pnpm-workspace.yaml` for pnpm, with nothing hoisted, in `package.json` for
npm). That is how `pnpm pack:smoke` and `pnpm image:smoke` make their apps before anything is published. Not for apps.

Changing the template: edit `apps/blank-app` and run `pnpm template:sync`; a test fails while the two differ.
