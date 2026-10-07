# Versions and deprecations

How Marmeon is versioned, what a version number promises, and how to upgrade. The short form is in the repository's
[README](../README.md#versions-and-deprecations); the changes themselves are in [UPGRADING.md](../UPGRADING.md) and in each
package's `CHANGELOG.md`.

## One version for the whole framework

The framework is released in **lockstep** (E152): every `@marmeon/*` package, the CLI `marmeon` and
`create-marmeon` always carry the same version, and the packages name each other at exactly that version. Upgrade them
together — `create-marmeon` writes them that way, and an app with two versions of a framework package has two containers
and two sets of tokens that do not know each other.

```sh
pnpm up --latest "@marmeon/*" marmeon     # every framework package of the app to the newest version, at once
```

## What a version promises

- **0.x — now.** Following [SemVer](https://semver.org/#spec-item-4), anything may change while the major version is 0 — but not
  silently: a **minor** version (0.1 → 0.2) may break, and every break has an entry in [UPGRADING.md](../UPGRADING.md) with its
  impact, the time it takes, before → after and the way back where there is one. A **patch** (0.1.0 → 0.1.1) never breaks.
  Pin the exact version (`create-marmeon` does) or `~0.1.0`; `^0.1.0` already means `<0.2.0`.
- **From 1.0 — after the reference app.** Breaking changes only in a major version. A feature to be removed is deprecated first,
  in a minor version: documented, marked `@deprecated` in its types, and warned about at runtime in development
  (`NODE_ENV=development` only — never in production logs). It goes in the next major, with its UPGRADING entry. What is marked
  `@internal` or `@experimental` is outside this promise. How long a major version gets bug and security fixes is set with 1.0,
  along Node's release lines.
- **Node:** 26.10 or newer (E9). A new minimum Node version is a breaking change.
- **Security fixes** go to the latest minor version ([SECURITY.md](../SECURITY.md)).

## A broken release

A release is never unpublished: a broken one is deprecated on npm (`npm deprecate`, naming the version to use instead) and fixed
by the next patch. Every release is staged first and goes live only after a maintainer approves it with two-factor
authentication; the packages carry npm provenance from the release workflow ([CONTRIBUTING.md](../CONTRIBUTING.md#changesets-and-releases)).

## The first day after a release

pnpm (11 and newer) holds a new version back for a day (`minimumReleaseAge`) — a protection against packages that are pulled
again soon after they appear. In that day `pnpm create marmeon` falls back to an older release or stops, and an upgrade to the
new exact versions fails to install. Wait a day, or let only the framework through for one command:

```sh
pnpm_config_minimum_release_age_exclude='["@marmeon/*","marmeon","create-marmeon"]' pnpm up --latest "@marmeon/*" marmeon
```

npm has no such delay.

## How to upgrade

1. Read the section of the new version in [UPGRADING.md](../UPGRADING.md) — the entries are sorted by impact, each says how likely
   it touches an app.
2. Move every framework package to the new version at once, install, and run `marmeon build` and your tests: type errors point at
   most of what changed.
3. Deploy as usual ([deployment](deployment.md)); a change that needs a migration or signs users out says so in its entry.
