# Release Policy

## Introduction

This page says how Marmeon is versioned, what a version number promises, and how you upgrade. Every package of the framework
carries the same version, so one number describes the whole framework:

```sh
pnpm up --latest "@marmeon/*" marmeon
```

That command moves every framework package of an app to the newest version at once. The changes of each version are in the
[upgrade guide](../UPGRADING.md), and each release adds them to the packages' `CHANGELOG.md` files.

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
- A **patch**, such as 0.1.0 to 0.1.1, never breaks.

Pin the exact version, as `create-marmeon` does, or use `~0.1.0`. A caret range such as `^0.1.0` already stops before 0.2.0.

### From 1.0 on

Breaking changes come only in a major version. A feature to be removed is deprecated first, in a minor version: documented,
marked `@deprecated` in its types, and warned about while the app runs in development, never in production logs. It goes in the
next major version, with its entry in the upgrade guide. What is marked `@internal` or `@experimental` is outside this promise.
How long a major version gets fixes is decided with 1.0.

### Node and security fixes

Marmeon needs Node 26.10 or newer. A new minimum version of Node is a breaking change. Security fixes go to the latest minor
version. The [security policy](../SECURITY.md) explains how to report a vulnerability.

## A broken release

A release is never taken back from npm. A broken one is deprecated there, with the version to use instead, and the next patch
fixes it. Every release is staged first and goes public only after a maintainer approves it with two-factor authentication. The
packages carry npm provenance from the release workflow, so you can check where each one was built. The
[contribution guide](../CONTRIBUTING.md#changesets-and-releases) describes the process.

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
