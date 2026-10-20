# Checking an App

## Introduction

`marmeon check` answers "am I done?" in one command: it runs the checks below, names each result and ends with an exit code a
script or an agent can act on. The tools (`types`, `lint`, `internal-imports`, `agents`) need no app. The other checks load it, once
registered and once booted, so they need the `.env` and, for [readiness](#the-app-checks), the services the app depends on.

```sh
pnpm marmeon check
```

```txt
✓ types
- lint skipped: oxlint is not installed — pnpm add -D oxlint
✗ internal-imports — 1 error
  modules/notes/Notes.ts:3:19  `@marmeon/*/internal` is the framework's own code, not API — …  (marmeon(no-internal-imports))
  docs: docs/check.md#imports-of-framework-internals
✓ boot
✗ route-types — 1 error
  bootstrap/routes.ts  bootstrap/routes.ts is out of date
  $ marmeon route:types
✓ modules
✓ readiness

Failed: a check found errors (exit 1).
```

A new app has the script: `pnpm check` runs `marmeon check`.

## The checks

| Name | What it does | Needs |
| --- | --- | --- |
| `types` | Type-checks the app with its own TypeScript (`tsc --noEmit`), as `marmeon build` does. | TypeScript and a `tsconfig.json` |
| `lint` | Runs the app's own [oxlint](https://oxc.rs/docs/guide/usage/linter) with its `.oxlintrc.json`. | oxlint |
| `internal-imports` | Finds [imports of framework internals](#imports-of-framework-internals). | nothing |
| `agents` | Warns when the marmeon block of `AGENTS.md` is [missing or out of date](#the-agents-block). | nothing |

The tools run side by side and are always listed in this order. `--only=types,lint` runs just those, `--skip=lint` runs all but
that one. A check you leave out is not in the report at all; it is not reported as `skipped`. A name that no check has, or options that leave no check to run (`--only=lint --skip=lint`), is a wrong call: the command lists the valid names and exits with 2. The app is loaded only when a selected check needs it, so `--only=types,lint` runs without an app.

## The app checks

After the tools come the checks that need the app, in this order: `boot`, the checks that need the app registered only (the
`build` checks), the checks that need it booted (the `run` checks), and `readiness`. The checks of a package or a module come in the order they are registered.

| Name | What it does | Phase |
| --- | --- | --- |
| `boot` | Starts the app. When it cannot start, the finding holds the message, its [error code](errors.md#server-error-codes) and the fix the solutions of the core and of the packages know (`APP_KEY` missing: `marmeon key:generate`). | |
| `route-types` | `bootstrap/routes.ts` matches the routes and views (a file of another Marmeon version is `H2`), and every route [says who may call it](authorization.md#every-route-decides) (`H3`). A missing file is an error: commit it. | build |
| `modules` | Job and notification classes under `modules/` that no module lists, as warnings. | build |
| `db-types` | `bootstrap/database.d.ts` matches the migrations (a file of another Marmeon version is `D7`); a missing file is an error. Reads the migration files, no database. | run |
| `readiness` | Runs the [readiness checks](health.md#liveness-and-readiness) of the packages, the modules and the app, the same as `/up/ready`: a failing one is an error named after it, one that takes longer than its time limit says so. | |

The `build` phase registers the app and boots nothing: it reads no secret and connects to nothing. The `run` phase boots it. If the
app does not load, `boot` fails and the checks that needed it are `skipped` with the reason "the app did not load" (or `error`, exit 3, with that reason when `boot` is not selected). Checks that
a package adds are known by the installed packages when the app does not load; those the app adds itself are not.

The default run needs the app's `.env` (or the variables in the environment) and, for `readiness`, the services it depends on.
`readiness` connects to them, such as the database and Redis. In CI without services, leave it out:

```sh
pnpm marmeon check --skip=readiness
```

What the app checks print is masked by the app's redactor, which masks what looks like a secret (a password in a connection URL
becomes `***`). It cannot know every secret: name none in a message. Nothing prints a stack, and the app's own directory is written
as `.`. While the checks run, a rejection or an exception that nobody handles is recorded the same way on the check that was
running, instead of ending the process.

## Checks from packages

A package or a module adds its own checks to this list. See [package development](package-development.md#checks).

## Status

Each check ends in one status:

| Status | Meaning |
| --- | --- |
| `passed` | It ran and found nothing. |
| `warning` | It found problems of the level warning only. |
| `failed` | It found at least one error. |
| `skipped` | It was not run, said in `reason`: no `tsconfig.json`, no `AGENTS.md`, oxlint is not installed (lint is the app's choice), or the app did not load ("the app did not load"). |
| `error` | It could not run, said in `reason`: TypeScript is not installed, a tool crashed, a check of a package threw or took longer than its time limit (a minute unless the check says `static timeout`), or the app did not load and `boot` was not selected. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every check that ran passed. Warnings are allowed, and so is a skipped check. |
| `1` | At least one check found an error. |
| `2` | `marmeon check` was called wrongly, for example `--only=bogus`. See the [console](console.md#exit-codes). |
| `3` | At least one check could not run (status `error`), or something failed outside every check (an unhandled rejection after a check ran out of time, said in `warnings`), and none found an error. |

A finding is more useful than a missing tool, so `1` wins over `3`.

## JSON output

`--json` prints one document, also when the exit code is `1` or `3`, because the findings are the result. When the call itself is
wrong (exit `2`), stdout stays empty and the message is on stderr. The format follows [machine-readable output](console.md#machine-readable-output).

```json
{
  "format": 1,
  "ok": false,
  "exitCode": 1,
  "checks": [
    {
      "name": "types",
      "status": "failed",
      "ms": 812,
      "reason": null,
      "problems": [
        { "severity": "error", "message": "Type 'string' is not assignable to type 'number'.", "file": "modules/notes/Notes.ts", "line": 4, "column": 7, "code": null, "rule": "TS2322", "fix": null, "docs": null }
      ]
    },
    { "name": "lint", "status": "skipped", "ms": 0, "reason": "oxlint is not installed — pnpm add -D oxlint", "problems": [] },
    { "name": "internal-imports", "status": "passed", "ms": 14, "reason": null, "problems": [] }
  ],
  "warnings": []
}
```

- `ok` is true exactly when `exitCode` is `0`.
- Every key is always there; what is not known is `null`. A problem has `severity` (`error` or `warning`) and `message`, and
  `file` (relative to the app, with `/`), `line` and `column` (from 1), `code` (a [Marmeon error code](errors.md#server-error-codes)),
  `rule` (the tool's name for it; for `readiness`, the name of the health check), `fix` (a command to run, never run by `check`) and `docs`.
- `warnings` is a list of texts: the app did not load so its own checks are not in the report, a name `--only`/`--skip` gave that nobody knows (only then, otherwise it is exit `2`), or an unhandled failure outside any check.
- `reason` says why a check was `skipped` or ended in `error`; it is `null` otherwise. The app's own directory is written as `.`.
- A new field is no new format. In CI, run `marmeon check` and read the exit code; use the document when a tool needs the findings.

## Imports of framework internals

Every package has a `./internal` entry (`@marmeon/core/internal`) that holds the framework's own plumbing: transaction frames,
guard internals, injection analysis. It is not API and can change in any release. An app that imports it, or that reaches
into a package's `dist` or `src`, works today and breaks silently at the next minor, and it can skip checks that the public API
keeps. The fix is the package's public entry, or an issue when something is missing.

The lint preset blocks `@marmeon/*/internal` too ([`make:lint-config`](console.md#lint)), but a lint rule can be removed or turned
off, so this check does not depend on `.oxlintrc.json`: it reads your files itself. It reports every place where one of these
appears as a string:

- `@marmeon/<package>/internal` and `marmeon/internal`,
- `@marmeon/<package>/dist/…`, `@marmeon/<package>/src/…`, `marmeon/dist/…` and `marmeon/src/…`,
- a path through `node_modules` to `@marmeon/…` or `marmeon/…` (`../node_modules/@marmeon/core/dist/x.js`, also written with `\`).

It looks in every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` file below the app, tests included, and finds
the string wherever it is written: `import`, `import type`, `export … from`, `import('…')`, `require('…')`, `vi.mock('…')`, a
template literal without an expression, a `/// <reference types="…" />` comment, a query or fragment after the subpath
(`'@marmeon/core/internal?raw'`), and an escaped spelling such as `'@\u006darmeon/core/internal'`. It also reads
every string in `tsconfig*.json` (`paths`, but also `extends`, `include` and the rest) and the `imports` of `package.json`.
Any other line in a comment is no import and is not reported. A path below `node_modules/.vite/` that mentions marmeon, the
pre-bundled copy of a package, counts as well.

It does not look into `node_modules`, a directory whose name starts with a dot (`.storybook`) or, at the root of the app,
`dist`, `storage` and `coverage` (a `modules/storage/` folder is read). It does not follow symlinked files or directories, and it
does not find:

- a specifier that is put together from parts (`'@marmeon/' + 'core/internal'`),
- a package alias (`npm:@marmeon/core`),
- a relative path that leaves the app to a checkout of the framework (`../../packages/core/src/…`),
- a file type other than the ones above (`.mdx`, `.vue`) or a config other than `tsconfig*.json` (`jsconfig.json`),
- a file it cannot parse. The `types` check reports it only when the file is part of the `tsconfig.json` `include`; an `.mjs` script outside it is reported by neither.

The check guards against the honest mistake, not against code that hides what it imports.

`marmeon build` runs the same scan and only warns, one line per place, so that a build is not held up by it; the exit code of
`marmeon build` does not change. `marmeon check` is what fails.

## The agents block

`agents` reads `AGENTS.md` and compares the block between the `marmeon:begin` and `marmeon:end` marks with the one the installed
`marmeon` writes. It only warns and writes nothing, so it never changes the exit code: the file belongs to your app.

| `AGENTS.md` | Result |
| --- | --- |
| Not there | `skipped`, with the reason "no AGENTS.md". |
| Its block is current | `passed`. |
| Its block is out of date, or it has none | `warning`, with the fix `marmeon agents:sync`. |
| Its marks are broken (a mark without its partner, two blocks) | `warning` with the reason; fix the marks, then run `marmeon agents:sync`. |
| Its marks are of a newer version than your `marmeon` | `warning` that says to update `marmeon`. |
| A link that leads nowhere or out of the app, or something that is no file | `warning`; it is not read. |

To keep the warning out of the report, run `marmeon agents:sync` and commit the result, or leave the check out with
`--skip=agents`. To make CI fail on a block that is out of date, use `marmeon agents:sync --check`. See
[coding agents](agents.md#keeping-the-block-current).
