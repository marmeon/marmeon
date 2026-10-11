# create-marmeon

Creates a Marmeon app: the starter kit — sign-in and registration, a layout, a home page, the devtools, oxlint and Vitest —
or a blank app. Node 26.10 or newer.

## Installation

Nothing to install — run it through your package manager:

```sh
pnpm create marmeon my-app            # on a terminal it asks: the starter kit? Docker files? pnpm or npm? git?
pnpm create marmeon my-app --yes      # the defaults, nothing asked: the starter kit, pnpm, install, a first commit
cd my-app
pnpm dev                              # http://localhost:3000 — the server with Vite, a queue worker and the scheduler
```

With npm, the creator's own flags follow a `--`:

```sh
npm create marmeon@latest my-app -- --npm
cd my-app
npm run dev
```

## Options

| Option | Effect |
| --- | --- |
| `<dir>` | The directory of the new app. On a terminal it is asked for when you leave it out. |
| `-y`, `--yes` | Takes the defaults and asks nothing. |
| `--minimal` | A blank app instead of the starter kit: no sign-in, no home page. |
| `--docker` | Adds a `Dockerfile`, a `.dockerignore` and a `compose.production.yaml`. |
| `--npm`, `--pnpm` | Chooses the package manager. pnpm is the default. |
| `--no-install` | Writes the files only. The output lists the commands to run next. |
| `--no-git` | Creates no git repository. |
| `-h`, `--help` | Shows the help. |
| `-v`, `--version` | Shows the version. Every framework package of the new app has this same version. |

Without a terminal nothing is asked: the flags and the defaults decide, and a missing directory ends the run with exit code 2.

## Documentation

- [Installation](https://github.com/marmeon/marmeon/blob/main/docs/installation.md)
- [Installation: options](https://github.com/marmeon/marmeon/blob/main/docs/installation.md#options)
- [Installation: the first day after a release](https://github.com/marmeon/marmeon/blob/main/docs/installation.md#the-first-day-after-a-release)
- [Starter Kit](https://github.com/marmeon/marmeon/blob/main/docs/starter-kit.md)
- [Deployment](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
