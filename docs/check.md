# Checking an App

## Introduction

`marmeon check` answers "am I done?" in one command: it runs the checks below, names each result and ends with an exit code a
script or an agent can act on. It does not boot the app, so it needs no `.env` and no database.

```sh
pnpm marmeon check
```

```txt
✓ types
- lint skipped: oxlint is not installed — pnpm add -D oxlint
✗ internal-imports — 1 error
  modules/notes/Notes.ts:3:19  `@marmeon/*/internal` is the framework's own code, not API — …  (marmeon(no-internal-imports))
  docs: docs/check.md#imports-of-framework-internals

Failed: a check found errors (exit 1).
```

A new app has the script: `pnpm check` runs `marmeon check`.

## The checks

| Name | What it does | Needs |
| --- | --- | --- |
| `types` | Type-checks the app with its own TypeScript (`tsc --noEmit`), as `marmeon build` does. | TypeScript and a `tsconfig.json` |
| `lint` | Runs the app's own [oxlint](https://oxc.rs/docs/guide/usage/linter) with its `.oxlintrc.json`. | oxlint |
| `internal-imports` | Finds [imports of framework internals](#imports-of-framework-internals). | nothing |

The checks run side by side and are always listed in this order. `--only=types,lint` runs just those, `--skip=lint` runs all but
that one. A check you leave out is not in the report at all; it is not reported as `skipped`. A name that no check has, or options that leave no check to run (`--only=lint --skip=lint`), is a wrong call: the command lists the valid names and exits with 2.

## Status

Each check ends in one status:

| Status | Meaning |
| --- | --- |
| `passed` | It ran and found nothing. |
| `warning` | It found problems of the level warning only. |
| `failed` | It found at least one error. |
| `skipped` | It was not run for a reason that is no fault of the app, said in `reason`: no `tsconfig.json`, or oxlint is not installed (lint is the app's choice). |
| `error` | It could not run, said in `reason`: TypeScript is not installed, or a tool crashed. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every check that ran passed. Warnings are allowed, and so is a skipped check. |
| `1` | At least one check found an error. |
| `2` | `marmeon check` was called wrongly, for example `--only=bogus`. See the [console](console.md#exit-codes). |
| `3` | At least one check could not run (status `error`), and none found an error. |

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
  `rule` (the tool's name for it), `fix` (a command to run, never run by `check`) and `docs`.
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
