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
- Interfaces an app implements itself, such as stores and drivers: a new required member is a break. An extension arrives as an
  optional member, or through a base class with a default.
- The names and defaults of environment variables.
- The commands of `marmeon`, their flags and exit codes.
- The table schemas of the migrations the framework ships, the stubs and the `make:*` tables.
- The protocol between client and server: headers and the page object.
- Stored formats: queue payloads, encrypted values, tokens and cookies.
- Translation keys, `@marmeon/react/styles.css` (its classes and custom properties) and the names of diagnostics channels.

Not part of it are `./internal` subpaths, anything marked `@internal` or `@experimental`, and the wording of messages and logs.

The same list decides, already in 0.x, whether a pull request is a `breaking` one.

> [!WARNING]
> **Security hardening.** A security hardening may break in a minor or a patch version. It then has an entry of its own in the
> [upgrade guide](../UPGRADING.md). Leaving a vulnerability open to keep an API protects nobody.

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
on, a minor before); its `@deprecated` tag says which one. The removal has an entry in the [upgrade guide](../UPGRADING.md).
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
