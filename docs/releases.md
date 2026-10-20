# Release Policy

## Introduction

This page says how Marmeon is versioned, what a version number promises, and how you upgrade. Every package of the framework
carries the same version, so one number describes the whole framework:

```sh
pnpm up --latest "@marmeon/*" marmeon
```

That command moves every framework package of an app to the newest version at once. The changes of each version are in the
[upgrade guide](../UPGRADING.md), and each release adds the merged pull requests that change something for users to the packages' `CHANGELOG.md` files and to the GitHub Release.

## One version for the whole framework

Every `@marmeon/*` package, the command `marmeon` and `create-marmeon` are released together, always with the same version. The
packages name each other at exactly that version. A new app gets them that way, and you keep it so: upgrade them together, never
one alone. Two versions of a framework package in one app would bring two containers and two sets of tokens that do not know each
other.

## What a version promises

### Before 1.0

Marmeon is at 0.x. Anything may change while the major version is 0, but never silently:

- A **minor** version, such as 0.1 to 0.2, may break. Every break has an entry in the [upgrade guide](../UPGRADING.md) with its
  impact, the time it takes, the code before and after, and the way back where there is one.
- A **patch**, such as 0.1.0 to 0.1.1, never breaks, except for a [security hardening](#what-is-public-api).

Pin the exact version, as `create-marmeon` does, or use `~0.1.0`. A caret range such as `^0.1.0` already stops before 0.2.0.

A fix for an older line is published under the npm dist-tag `latest-<line>` (`latest-0.1`) and never moves `latest`. An app that
stays on that line gets it through `pnpm up "@marmeon/*" marmeon` when its range allows the version (`^0.1.0`, `~0.1.0`), or
installs it by name (`pnpm add @marmeon/core@latest-0.1`, then the same for the other packages); an exact pin changes by hand.

### From 1.0 on

Breaking changes come only in a major version, except for a [security hardening](#what-is-public-api). A feature to be
removed is [deprecated](#deprecations) first, in a minor version, and goes in the next major version, with its entry in the
upgrade guide. What is outside the [public API](#what-is-public-api) is outside this promise. [Which versions get
fixes](#which-versions-get-fixes) is a separate question.

## Which versions get fixes

Before 1.0, fixes are promised only for the latest 0.x minor version; a maintenance release for an older line is possible but not
promised. From 1.0 on, the current major version gets them in its latest minor version. The previous major version still gets
**security fixes for 12 months** after the next major version is released, as patches on its last minor version, published under
the dist-tag `latest-<major>` like [any older line](#before-10).

Once 1.0.0 is released, 0.x gets no fixes at all. It never had a support window, and the way forward is the section "0.x to 1.0"
of the [upgrade guide](../UPGRADING.md).

| Version | Fixes | Security fixes |
|---|---|---|
| Current major | latest minor version | latest minor version |
| Previous major | no | 12 months after the next major is released |
| Older majors | no | no |
| 0.x, before 1.0 | latest minor version | latest minor version |
| Older 0.x minors | no | no |
| 0.x, after 1.0.0 | no | no |

The [security policy](../SECURITY.md) explains how to report a vulnerability.

## Supported platforms

A "major version" in this section means the next breaking release: a major version from 1.0 on, a minor version before.

### Node

Marmeon supports the LTS lines of Node from 26 on. Today that means Node 26.10 or newer (`engines` in every package). The rules
for changing it:

- A line is dropped only after its end of life, and only in a major version.
- Within a line, the minimum version rises in a minor version only for a security fix in Node.
- Supporting a new LTS line is a minor change.

### TypeScript and ES modules

An app needs TypeScript 7 and the options of the starter's `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax` and a
`lib` with `ESNext.Temporal`. The packages are ES modules only; there is no CommonJS build.

### Libraries the framework builds on

- **Peers**: React, React DOM, Vite, Vitest, the OpenTelemetry API, TanStack Table, and the drivers an app picks (`pg`, `mjml`, the
  AWS SDK). Supporting one more major version of a peer is a minor change; dropping a major version is a major change.
- **Kysely**: you write Kysely's builder through `@marmeon/database` and never import the `kysely` package. It is an exact
  dependency of the framework, not a peer. The shape of the builder (methods, `eb`, result types) is public API: a Kysely update
  that changes it comes only in a Marmeon major version, with an entry in the [upgrade guide](../UPGRADING.md). An update an app
  does not notice comes in a minor version, with a `Low` entry there. Security fixes of Kysely are taken into every supported
  line. Which version that is: [database](database.md#kysely-and-its-version).

## What is public API

The promise of a version covers the public API. These are part of it:

- The exports of each package's entry points, `.` and the documented subpaths, types included.
- The contracts an app implements for authentication ([listed here](authentication.md#what-your-app-implements)): `SignInStore`,
  `PasswordResetTokenStore`, `AccessTokenStore` and `TwoFactorState` of `@marmeon/auth`, and `SessionStore` of `@marmeon/session`, are
  abstract classes your store extends. A member added later has a default, unless it is
  [security-relevant](authentication.md#security-relevant-members): that comes only as a security hardening or in a major
  version and never has a default. `UserProvider` and `Hasher` are interfaces: a security-relevant member is added the same way; any
  other member is optional.
- Other interfaces an app implements itself, such as the drivers of cache, queue and storage: a new required member is a break. An
  extension arrives as an optional member.
- The names and defaults of environment variables.
- The commands of `marmeon`, their flags and exit codes.
- The documents `--json` prints, by their `format`.
- The table schemas of the migrations the framework ships, the stubs and the `make:*` tables. The migrations the framework's packages ship, the starter kit's among them, are append-only: a released file never changes, and a change of a table is a new file ([tables](package-development.md#tables)).
- `defineMigration`, `up(schema)` and the schema builder, including which plans they accept and what they create: a migration that ran keeps its meaning.
- The protocol between client and server: headers and the page object.
- Stored and wire formats: queue payloads, sessions, encrypted values, tokens, cookies, the record of migrations and the generated files, as
  [listed below](#stored-and-wire-formats).
- Translation keys, `@marmeon/react/styles.css` (its classes and custom properties) and the names of diagnostics channels and the
  shape of their messages.

Not part of it are `./internal` subpaths, anything marked `@internal` or [experimental](#experimental), and the wording of messages and logs.

The same list decides, already in 0.x, whether a pull request is a `breaking` one.

> [!WARNING]
> **Security hardening.** A security hardening may break in a minor or a patch version. It then has an entry of its own in the
> [upgrade guide](../UPGRADING.md). Leaving a vulnerability open to keep an API protects nobody.

### Stored and wire formats

Anything that outlives a process or travels between two of them is a format: a record in a queue, a session in its store, a cookie,
a header between a tab and a server, a file the framework generates. Each carries a mark in a fixed place, and the meaning of that
mark never changes. A reader knows a set of versions, today one per format, and treats data by that set:

- **Newer than it knows:** it leaves the data alone. A newer process may be running, and what it wrote is not for an older one to
  overwrite, delete or guess at. The reader refuses, or treats the request as one without the data. Two things end such data
  all the same: a worker lets a record it cannot read fail after six hours, which takes it out of the queue, and a sign-in or sign-out
  on an older node ends the newer session of that request.
- **Older than it supports, or without a mark:** it never interprets the data. What a migration can carry over, `marmeon migrate` carries
  over (the framework's tables). Everything else counts as missing: a session starts anew, a cookie is not
  read, a job fails with its reason and stays readable in the failed jobs.

A reader never guesses and never falls back to a default.

| Format | Mark | A newer version is | An older one, or none, is |
| --- | --- | --- | --- |
| [Page protocol](navigation.md#a-tab-of-another-protocol-version) | the header `x-marmeon: 1` on every request of the client | answered with `409` before routing, whatever the method | the same: an old tab sends `true`, or nothing |
| Page object and region object (JSON) | none; new fields are optional | carried along; without `component`, `props` and `url` it is no page | read as they are |
| [Job record](queues.md#deploying-while-jobs-wait) | `v` in the payload | put back untouched until a worker reads it; after six hours it fails and leaves the queue | failed at once with the reason, never run |
| [Queued listener](events.md#queued-listeners) | the listener's `static listener` name, within its event | put back like an unknown job | failed like any record without a version |
| [Session](session.md#what-a-session-stores) | `_v` in the payload | the request is a guest's; the stored session stays as it is | dropped, a new session starts |
| [Session and remember-me cookies](session.md#the-__host--prefix) | the name, with `__Host-` when cookies are `Secure` | n/a | a cookie under another name is never read |
| [Record of migrations](migrations.md#how-the-migrator-keeps-track) | the columns of `migrations` (and of `migration_lock`) | `migrate` refuses; every query on the connection fails and `/up/ready` is red | `migrate` adds `checksum` and records each file as it is then; until it ran, every query fails (D2) and `/up/ready` is red |
| [Encrypted values](encryption.md#what-the-key-protects) | a version byte, and a context per use (`cookie:<name>`, `session:<key>`, `queue:v1:<job>`) | `DecryptError` | `DecryptError` |
| [API tokens](api-tokens.md#the-token-format) | the prefix, and a hash under its own domain | not a token: 401, like an unknown one | no longer valid: 401, like an unknown one |
| [Generated types](queries.md#table-types) (`bootstrap/routes.ts`, `bootstrap/database.d.ts`) | `// @marmeon-format 1` on the third line | `--check` fails with "update `@marmeon/*`"; no command overwrites it | `--check` says another version wrote it; regenerate |
| [Copied files](starter-kit.md#what-the-auth-module-holds) (`marmeon-stubs.json`) | `format` in the file | `make:auth` stops and writes nothing | `make:auth` stops and writes nothing: there is no older version |
| [Schema projection](migrations.md#what-the-migrations-describe) (`.marmeon/schema.json`) | `format` in the file, and the version of `@marmeon/database` | computed again and written over: the file is a cache | computed again and written over |
| [The block of `AGENTS.md`](agents.md#the-marks) | `<!-- marmeon:begin v1 -->` and `<!-- marmeon:end -->`, each on a line of its own | `agents:sync` refuses and writes nothing | the text between the marks is replaced; without marks the block is appended |
| [`--json` of a command](console.md) | `format`, the first key | n/a: the command prints its newest | n/a |

Some formats have no version of their own and are kept stable another way:

- **Signed URLs, upload tokens and live tokens** are tied to `APP_KEY` through a key derived per purpose (`marmeon:<purpose>`, so a
  signature is never also a cookie or session key). A change of the form arrives as a new parameter or a new derivation, so an old
  link or token fails closed. Links in mails live long, so a signed URL only ever grows. An upload token starts with `tu_`, which
  serves as its version.
- **Messages between nodes** (live updates over Redis, the tab sync) carry a `kind` or a `v`. A reader drops a message it does not
  know. Such a message never carries data: it tells a tab to ask the server, which answers through the route and its authorisation.
- **`history.state`** holds the URL, component, a key and the scroll position. An entry that does not match loads from the server.
- **The names of keys** in the cache and the lock store (`limiter:…`, `queue:unique:…`, the scheduler's locks) and the names of
  [encryption contexts](encryption.md#what-the-key-protects) are format: two nodes must agree on them. A release that renames one
  does so with the same care as a renamed column.

Fixtures sit under `__fixtures__/formats/`, one per version: the page and region object, the job record, the Redis member, queued
listeners, mails and notifications, the session payload, the record of migrations, API tokens, the manifest of copied files and the `--json` documents. A test reads each
directory with the current code. A pull request that changes or deletes a fixture is a `breaking` one. [Changing a stored or wire format](../CONTRIBUTING.md#changing-a-stored-or-wire-format)
says how a format moves on.

From 1.0 on, every change of a format ships so that a rolling deploy works: the release that first writes version N is one whose
readers already read N, and a table is not renamed in place but created anew, written twice and dropped over two releases. The
upgrade to the first release that marks these formats is the exception, and cannot be rolling: [the upgrade that stops every
process](deployment.md#the-upgrade-that-stops-every-process) lists what to do and what it costs.

### Experimental

Experimental means: it can change or go away in any minor version, without an entry in the [upgrade guide](../UPGRADING.md). It
is still listed in the package's `api.md`, under **Experimental**, so a change shows in the pull request's diff, but the
`breaking` label is not required for it. Build on it only when you can follow the releases. What is experimental today:

- `@marmeon/devtools`
- `@marmeon/http/client/adapter`: the interface a UI adapter builds on (the navigator, regions and layers, the feature wiring,
  loading the first page). It stays experimental until a second adapter exists. What an app uses of the client core (`hooks`, `tabSync`, `xsrfToken`) stays in
  `@marmeon/http/client`.
- `@marmeon/live`
- `@marmeon/otel`
- `@marmeon/table`
- `@marmeon/react/table`
- `@marmeon/react/table-tanstack`
- `marmeon tinker`

The options `pages` and `lang` of the Vite plugin and the members of `@marmeon/testing` that follow an experimental
package (`devtools`, `broadcast`, `live` of the test app) are experimental too, one by one; their declarations say so.

So is `features` of `ResolvePage` in `@marmeon/react`, which names a type of `@marmeon/http/client/adapter`.

### When a union grows

A new member of a union, such as a string value, a field of an event like `via`, or a message of a diagnostics channel, is a
minor change. It ships as an ordinary `feature`, and the title of its pull request names the new member (for example "Add
'magic-link' to LoginVia"), so the release notes show it.

The exception is the `err` kinds of the [results the framework returns](errors.md#results-the-framework-returns). They are
closed: a new kind comes only with a new method, so an exhaustive `switch` with `satisfies never` compiles across minor versions.

Everywhere else, handle a value you do not know in a `default` branch. Here `event` is a `Login` event:

```ts
switch (event.via) {
  case 'attempt':
    return 'password';
  case 'passkey':
    return 'passkey';
  case 'remember':
    return 'cookie';
  default:
    return 'other';
}
```

### Deprecations

What is removed is deprecated first, in a minor version: marked `@deprecated` in its types, with the replacement and a link to
the docs, and warned about once per process as soon as it is used, **only** when `NODE_ENV` is `development` or `test`. On the server,
the warning is a Node `DeprecationWarning`: `node --no-deprecation` turns it off, and `node --throw-deprecation` turns it into
an error; in the browser it goes to the console. It is removed at the earliest in the next breaking release (a major version from 1.0
on, a minor before); its `@deprecated` tag says which one (from 1.0 on, `Removed in 2.0` and the like, never a minor). The removal has an entry in the [upgrade guide](../UPGRADING.md).
[Package development](package-development.md#deprecating-an-api) shows how a package deprecates an API.

## A broken release

A release is never taken back from npm. A broken one is deprecated there, with the version to use instead, and the next patch
fixes it. What the release workflow publishes is staged first and goes public only after a maintainer approves it with two-factor
authentication, and it carries npm provenance, so you can check where it was built. A package's very first version has to be
published by hand, before trusted publishing can be set up for it. The
[contribution guide](../CONTRIBUTING.md#pull-requests-and-releases) describes the process.

## The first day after a release

pnpm 11 and newer hold back any package version younger than their `minimumReleaseAge`, one day by default. This protects you
from a package that is pulled again soon after it appears. For a day after a Marmeon release, an upgrade to the new exact
versions therefore fails to install, and `pnpm create marmeon` falls back to an older release or stops.

Wait a day, or let only the framework through for this one command:

```sh
pnpm_config_minimum_release_age_exclude='["@marmeon/*","marmeon","create-marmeon"]' pnpm up --latest "@marmeon/*" marmeon
```

The variable changes nothing else, and only this command sees it. npm has no such delay.

## How to upgrade

1. Read the section of the new version in the [upgrade guide](../UPGRADING.md). Its entries are sorted by impact, and each says
   how likely it touches your app.
2. Move every framework package to the new version at once, install, and run `pnpm marmeon build` and your tests. Type errors
   point to most of what changed.
3. Deploy as usual. An entry says so when a change needs a migration or signs users out. The [deployment](deployment.md) page
   covers the rest.
