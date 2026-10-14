# @marmeon/mail

## 0.2.0

### Breaking changes

- Add two-factor authentication with TOTP and recovery codes by @maxeckel in https://github.com/marmeon/marmeon/pull/16
- Refuse to start when a route does not say who may call it by @maxeckel in https://github.com/marmeon/marmeon/pull/33

### Features

- Add UUIDv7 keys, as primary keys or as public lookup keys by @maxeckel in https://github.com/marmeon/marmeon/pull/14
- Give the starter kit a look of its own by @maxeckel in https://github.com/marmeon/marmeon/pull/15
- Add a middleware that requires two-factor authentication on routes by @maxeckel in https://github.com/marmeon/marmeon/pull/17
- Add passkeys as a second factor and for passwordless sign-in by @maxeckel in https://github.com/marmeon/marmeon/pull/20
- Prove the second factor again with a passkey by @maxeckel in https://github.com/marmeon/marmeon/pull/24
- Add two-factor authentication pages to the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/26
- Add passkeys to the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/27
- Let route groups authorize their routes, and mark open ones with `everyone` by @maxeckel in https://github.com/marmeon/marmeon/pull/29

### Fixes

- Give the starter kit's tests time on a busy machine by @maxeckel in https://github.com/marmeon/marmeon/pull/11
- Stop sharing the user's id with every page of the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/12
- End new apps' page titles with the app's name by @maxeckel in https://github.com/marmeon/marmeon/pull/13
- Prune expired entries from the memory cache as it writes by @maxeckel in https://github.com/marmeon/marmeon/pull/21
- Expect the public profile id in the two-factor test by @maxeckel in https://github.com/marmeon/marmeon/pull/23
- Post the web app's two-factor forms even before hydration by @maxeckel in https://github.com/marmeon/marmeon/pull/25
- Send only the fields a profile page shows to other users by @maxeckel in https://github.com/marmeon/marmeon/pull/32
- Stop writing an `authorize` that always says yes to type a controller's context by @maxeckel in https://github.com/marmeon/marmeon/pull/31

### Documentation

- Add a guide that builds a small app step by step by @maxeckel in https://github.com/marmeon/marmeon/pull/19
- Say on the website whom Marmeon is for, and link the community by @maxeckel in https://github.com/marmeon/marmeon/pull/35

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.3...v0.2.0

## 0.1.3

### Fixes

- Ship the starter kit in German as well as English by @maxeckel in https://github.com/marmeon/marmeon/pull/4
- Sign out without making Chrome clear its whole disk cache by @maxeckel in https://github.com/marmeon/marmeon/pull/5
- Switch the language without clearing the browser's cache by @maxeckel in https://github.com/marmeon/marmeon/pull/6

### Documentation

- Link every package to its docs on marmeon.com and ship its changelog by @maxeckel in https://github.com/marmeon/marmeon/pull/3

### New contributors

- @maxeckel made their first contribution in https://github.com/marmeon/marmeon/pull/3

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.2...v0.1.3

## 0.1.2

### Patch Changes

- @marmeon/queue@0.1.2
  - @marmeon/core@0.1.2
  - @marmeon/router@0.1.2

## 0.1.1

### Patch Changes

- f56608b: Publish every package through the release workflow, with npm provenance.
- Updated dependencies [f56608b]
  - @marmeon/core@0.1.1
  - @marmeon/queue@0.1.1
  - @marmeon/router@0.1.1

## 0.1.0

### Minor Changes

- The first release (0.1.0): every package of the framework — the application kernel with constructor injection, the router, the
  page protocol and the React adapter, sessions, auth, the data layer, mail, queues, the scheduler, storage, live props, i18n, the
  devtools and OpenTelemetry — together with `create-marmeon`, all at one version.

### Patch Changes

- Updated dependencies
  - @marmeon/core@0.1.0
  - @marmeon/queue@0.1.0
  - @marmeon/router@0.1.0
