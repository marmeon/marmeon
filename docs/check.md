# Checking an App

## Introduction

`marmeon check` answers "am I done?" in one command: it runs the checks below, names each result and ends with an exit code a
script or an agent can act on. The tools (`types`, `lint`, `internal-imports`, `raw-sql`, `inner-html`, `agents`, `packages`) need no app. The other checks load it, once
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
✓ raw-sql
✓ inner-html
✓ boot
✗ route-types — 1 error
  bootstrap/routes.ts  bootstrap/routes.ts is out of date
  $ marmeon route:types
✓ modules
✓ throttle
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
| `raw-sql` | Warns about [`sql.raw()` and `sql.lit()` with an argument that is not a literal](#raw-sql). | nothing |
| `inner-html` | Warns about [HTML that code sets from a value that is not a literal](#html-from-code). | nothing |
| `agents` | Warns when the marmeon block of `AGENTS.md` is [missing or out of date](#the-agents-block). | nothing |
| `packages` | Fails when a `marmeon` or `@marmeon/*` package is [not in the app's version](#the-packages-check). | nothing |

The tools run side by side and are always listed in this order. `--only=types,lint` runs just those, `--skip=lint` runs all but
that one. A check you leave out is not in the report at all; it is not reported as `skipped`. A name that no check has, or options that leave no check to run (`--only=lint --skip=lint`), is a wrong call: the command lists the valid names and exits with 2. The app is loaded only when a selected check needs it, so `--only=types,lint` runs without an app.

## The app checks

After the tools come the checks that need the app, in this order: `boot`, the checks that need the app registered only (the
`build` checks), the checks that need it booted (the `run` checks), and `readiness`. The checks of a package or a module come in the order they are registered.

| Name | What it does | Phase |
| --- | --- | --- |
| `boot` | Starts the app. When it cannot start, the finding holds the message, its [error code](errors.md#server-error-codes) and the fix the solutions of the core and of the packages know (`APP_KEY` missing: `marmeon key:generate`). | |
| `route-types` | `bootstrap/routes.ts` matches the routes and views (a file of another Marmeon version is `H2`), and every route [says who may call it](authorization.md#every-route-decides) (`H3`), and no route has [two middleware that add the same key](middleware.md#listed-twice) (`H8`). A missing file is an error: commit it. | build |
| `modules` | Job and notification classes under `modules/` that no module lists, as warnings. | build |
| `throttle` | Warns at [routes that anyone may call to change something and nothing limits](#routes-without-a-limit). Reads the routes, no database. | build |
| `package-migrations` | Every package your app publishes from has all its migrations in the app, the answer of `marmeon publish --check`: one that is missing is `D6` with the fix `marmeon publish <package>`, one `publish` refuses is an error with the reason. Packages you have not published from are left out. A package whose declaration cannot be read is listed by `marmeon publish`, but checked only when `publish` made a module for it. A `static migrations` that cannot be read (it is no object, or `from` is no `file:` URL) belongs to the package that exports its provider (found among the packages that list providers in `marmeon.providers`) and is treated like any refusal of it; one no direct dependency exports, and a declaration a package does not claim, are warnings. A package taken into an existing module with `--module` is not checked here; use `marmeon publish --check <package>`. Reads files and imports the main entry of the direct dependencies a declaration points into; no database. | build |
| `hsts` | Warns when production on an `https` `APP_URL` sends [no `Strict-Transport-Security`](#hsts). Asks the booted app once. | run |
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
| `error` | It could not run, said in `reason`: TypeScript is not installed, a tool crashed, a check of a package threw or took longer than its time limit (a minute unless the check says `static timeout`, in seconds), or the app did not load and `boot` was not selected. |

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
      ],
      "silenced": []
    },
    { "name": "lint", "status": "skipped", "ms": 0, "reason": "oxlint is not installed — pnpm add -D oxlint", "problems": [], "silenced": [] },
    { "name": "internal-imports", "status": "passed", "ms": 14, "reason": null, "problems": [], "silenced": [] }
  ],
  "warnings": []
}
```

- `ok` is true exactly when `exitCode` is `0`.
- Every key is always there; what is not known is `null`. A problem has `severity` (`error` or `warning`) and `message`, and
  `file` (relative to the app, with `/`), `line` and `column` (from 1), `code` (a [Marmeon error code](errors.md#server-error-codes)),
  `rule` (the tool's name for it; for `readiness`, the name of the health check), `fix` (a command to run, never run by `check`) and `docs`.
- `silenced` lists the findings a [comment silenced](#silencing-a-finding), each a problem with the `reason` the comment gives; it is `[]` for a check with none. They do not count towards `status`.
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

## Raw SQL

`sql.raw(text)` and `sql.lit(value)` put their argument into the SQL as written, so a value from a request becomes SQL: an
injection. `raw-sql` warns about every call whose argument is not a literal, at the argument. The fix is to put the value in a
`sql` template with `${value}`, which sends it as a parameter ([queries](queries.md#writing-queries)); a column or table
name comes from a list in the code, and `sql.ref()` and `sql.table()` take it as a name. If the argument is safe, say why in a
[comment](#silencing-a-finding).

A literal is a string, a template without an expression, a `+` of literals, any of them in parentheses or with `as const` or
`satisfies`, and a name that the file declares exactly once as `const NAME = <literal>`. A constant from another file is not a
literal (move it into the file, or silence the call), and neither is a function call, whatever it is called: `sanitize(name)`
is no proof.

`sql` is the name `sql`, an import of it from `@marmeon/database` or `kysely` under another name (`import { sql as q }`),
`sql` of a namespace import (`db.sql.raw(…)`), or a `const` set to one of them (`const s = sql`). Parentheses, `as` and `!` around
it, `sql['raw']`, `const { raw } = sql` and `sql.raw.call(…)` or `.apply(…)` do not hide a call. The check reads the sources below the app the way [`internal-imports`](#imports-of-framework-internals)
does, but not the tests (`*.test.*`, `*.spec.*`, `*.type-test.*`): what a test passes is no input. It is a warning, so the exit
code stays `0`. It does not find `sql.ref()` and `sql.table()` (names, which the database quotes), a `sql` that your own module re-exports under
another name, a `sql` passed through a function or an object, a call through a variable that is not a plain `const` (`let raw = sql.raw`), or a file it cannot parse (the `types` check reports it).

## HTML from code

HTML that code sets from a value is a cross-site scripting hole when the value comes from a request: the page runs what the
value holds. The [content security policy](security.md) limits what that script can do; it does not replace escaping. `inner-html`
warns, at the value, about:

- the JSX attribute `dangerouslySetInnerHTML` and a property of that name (`createElement(…, { dangerouslySetInnerHTML })`),
  unless the value is `{ __html: <literal> }`,
- an assignment to `.innerHTML` or `.outerHTML`, with `=` or `+=`, and one to `.__html`,
- the JSX attribute `srcDoc` and an assignment to `.srcdoc`, which make a document of the HTML an iframe shows,
- `insertAdjacentHTML(position, html)`, `createContextualFragment(html)` and `setHTMLUnsafe(html)`,
- `write(…)` and `writeln(…)` of a document: `document`, `window.document`, `iframe.contentDocument` and `el.ownerDocument`.

The fix is to show the value as text: `{value}` in JSX, `textContent` in the DOM. If the HTML is safe, say why in a
[comment](#silencing-a-finding); in JSX the comment goes in a `{/* … */}` on the line above the attribute.

A literal is the same as for [`raw-sql`](#raw-sql). A function call is none, whatever it is called: `sanitize(html)` is no proof,
because the check cannot know what the function does. Parentheses, `as`, `!` and `?.` around a value or an element, a `const` that
holds the `{ __html }` object or the method (`const p = { __html: html }`, `const add = el.insertAdjacentHTML`), `el['innerHTML']`,
`.call()`, `.apply()` and `.bind()` do not hide a sink. It reads the sources like `raw-sql`, so the tests are not read.

It is a warning, so the exit code stays `0`. It does not find:

- an object that reaches the attribute from elsewhere (`{...props}` where `props` holds `dangerouslySetInnerHTML`, a function that
  returns the object, or one from another file),
- a property whose key is a variable (`{ [key]: … }`),
- a method taken out of its object (`const { insertAdjacentHTML } = el`), or one called through `Reflect` or `Object.assign(el, { innerHTML })`,
- a setter of another name that parses HTML (`DOMParser`, `setAttribute('srcdoc', …)`, a library's `html()`), or a file it cannot parse.

## Routes without a limit

A route that anyone may call without signing in and that changes something is open to spam, to guessing (a password, a code) and to
cost (every request may send a mail or start a job). `throttle` warns, in the registered routes and without booting the app, at
every route that

- is the app's own (a route the framework itself registers is left out),
- allows `everyone` and nothing else: every [access check](authorization.md#every-route-decides) of the route is `everyone`,
- answers a method other than `GET`, `HEAD` and `OPTIONS` (`POST`, `PUT`, `PATCH` or `DELETE`, also through `Route.match()` and `Route.any()`), and
- has no middleware that [declares](middleware.md#declaring-what-a-middleware-ensures) that it limits or authenticates: of the app,
  of the route's group, of a prefix group around it, or of the route itself.

```txt
! throttle — 1 warning
  modules/contact/routes.ts:6  POST /contact (contact.send) can be called by anyone and nothing limits it — add `throttle('<name>')` (or `authenticate()`), or silence this with `// marmeon-check-ignore throttle: <why it needs no limit>`  (marmeon(throttle))
  docs: docs/rate-limiting.md#applying-limits-to-routes
```

The fix is `throttle('<name>')` on the route or its group ([rate limiting](rate-limiting.md#applying-limits-to-routes)), or
`authenticate()` when only signed-in users should call it. Where a limit is wrong, say why in a [comment](#silencing-a-finding) on the
line of the `.post(` call, or on the line above it; for a route whose chain runs over several lines, that is the line of the call
that names the method. A comment above a group covers nothing inside it, so each route of the group needs its own.

What counts as a limit or a sign-in is what a middleware says about itself in `static ensures`, not what it does. `throttle()` says
`'rate-limited'`; `authenticate()`, `authenticate('api')` and `signed()` say `'authenticated'`. The check does not run the middleware:

- A middleware that declares it counts even if it does nothing, and so does a `throttle()` whose limiter has no limits. A
  `static ensures` that is not an array of those names (`'rate-limited'`, `['trusted']`) counts for nothing.
- A route whose access check is more than `everyone` is not reported, though the check may let guests through: a policy through
  `can()` or a request's own `authorize`. The check cannot tell. A route that says nothing about who may call it is `route-types`' error, not this finding.
- It looks at who may call and how, not at what the action does: a `POST` that only reads is reported, and so is a route that touches no record.
  `{ public: true }` on a binding is no finding either way: it concerns the records a route may read.
- Middleware that a package appends to a group only in its `boot()` is not seen: the check reads the routes as registered, and the
  `global`, `web` and `api` lists of `defineApplication({ middleware })`.
- A middleware that limits by other means than a named limiter, such as a proxy's limit in front of the app, is invisible to it.
- A route that a package registers on behalf of the app is placed on the line in the app's own file that registered it; one with no
  such line has no file and cannot be silenced by a comment.

It is a warning, so the exit code stays `0`.

## HSTS

Without [`Strict-Transport-Security`](security.md#strict-transport-security) a browser's first visit over plain `http://` can be kept
on HTTP by an attacker on the path. `hsts` warns when none is sent. It is only checked when the app runs as production
(`NODE_ENV=production`) and `APP_URL` starts with `https://`; in development and test, and with an `http://` `APP_URL`, it is
`skipped`. So run it with your production environment, before going live:

```sh
NODE_ENV=production pnpm marmeon check --only=boot,hsts
```

It starts the app and runs its code once: a single `GET` of `https://<APP_URL host>/_marmeon/hsts-probe`, handed to the app
from the loopback address, with `accept: application/json`, no cookies and no body. The answer is thrown away. That path is
under `/_marmeon/`, which belongs to the framework, and the app's global middleware sees it like any request, which is where
`securityHeaders()` adds the header. A failing probe makes the check `error`.

```txt
! hsts — 1 warning
  Responses over HTTPS carry no Strict-Transport-Security header. Turn it on with securityHeaders({ hsts: … }) in bootstrap/app.ts once the site answers over HTTPS only. If your proxy sets it, leave this check out there: --skip=hsts.  (marmeon(hsts))
  docs: docs/security.md#strict-transport-security
```

It warns when the response has no header, a header without a valid `max-age` or with two of them (a browser ignores it), or `max-age=0`, which
turns HSTS off. It reads the header as a browser does: any letter case, and when several come, the first.

- The app is asked, not the proxy in front of it. Where the proxy sets the header, the check warns although visitors get it: run
  it with `--skip=hsts` there.
- A header that the middleware of a group or of a route, or a controller, sets is not seen: the probe passes through the global
  middleware only. That is a false alarm like the proxy's; `--skip=hsts` there too.
- The probe looks like a real request: the log has a line `GET /_marmeon/hsts-probe 404`, a trace records it, and a global
  middleware with a side effect runs once.
- `includeSubDomains` and `preload` are not looked at; `securityHeaders()` already refuses `preload` without `includeSubDomains` and a `maxAge` of a year.
- It is a warning, so the exit code stays `0`, and it cannot be silenced by a comment.

## Silencing a finding

A finding of `raw-sql`, `inner-html` or `throttle` can be silenced by a comment with a reason, on the line of the finding or the line above it:

```ts
// marmeon-check-ignore raw-sql: the column is one of SORTABLE, checked above
const order = sql.raw(column);
```

The syntax is `marmeon-check-ignore <check>[, <check>]: <reason>`, as a `//` comment, a `/* … */` comment or, in JSX,
`{/* … */}`. Only a real comment counts; the same text in a string does nothing.

- The reason is required. A comment without one silences nothing, and `check` warns about the comment.
- A silenced finding is not gone. It leaves `problems` and `status`, and shows in the report: `✓ raw-sql (1 silenced)` and a line
  `silenced  file:line  reason` under it, and in `--json` as an entry of `silenced` with its `reason` (cut to 200 characters). A
  reviewer sees the reason in the diff and in the report.
- A comment that silences nothing is a warning too: remove it. A name that is no check silences nothing and is not reported.
- `internal-imports` cannot be silenced. A framework internal is never an exception.
- Only `raw-sql`, `inner-html` and `throttle` can be silenced this way.
- A comment at the end of a line covers that line only. A comment on its own line (in JSX, `{/* … */}`) covers its last line and the next.

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

## The packages check

Every `@marmeon/*` package pins the others it needs to one exact version, and `marmeon` and the packages are released together.
`pnpm add @marmeon/storage` takes the version `latest` names, so in an app on another version it installs a second `@marmeon/core`
next to the app's, and the package manager only warns about peers. `packages` reads the `package.json` of the app and the installed
packages (no app is loaded, no file is searched) and compares each `marmeon` and `@marmeon/*` it lists with `@marmeon/core`:

| Finding | Level |
| --- | --- |
| A package is installed in another version than `@marmeon/core`. The message names the package, both versions and the command in your package manager, chosen by the lockfile (`pnpm add -E @marmeon/storage@<the app's version>`, or `npm install -E …` with a `package-lock.json` and no `pnpm-lock.yaml`). | error |
| A package that is in the app's version, or a package of someone else the app lists, pulls an `@marmeon/*` in a different version, so a second copy is installed. | error |
| A package is listed with a range (`^1.0.0`) or a tag instead of an exact version. | warning |
| A package that is not looked up by version (`workspace:*`, `file:`, `link:`). | not reported |
| No `@marmeon/core` installed. | `skipped` |
| `package.json` cannot be read. | `error`, "could not run" |

Fix a finding with the command it shows; `-E` saves the version exactly, and `-D` is added for a package listed under
`devDependencies`. `marmeon dev` runs the same comparison at each start of the server, so after every restart, and warns without
stopping, and a `K3` error of any command ends with it too, since a package that is read in another version is a usual reason for it. `marmeon start` does not look: the
production server starts what CI has checked. Leave the check out with `--skip=packages`.
