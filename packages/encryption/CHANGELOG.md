# @marmeon/encryption

## 0.1.2

### Patch Changes

- 40e296c: An app now refuses to start with the public test key of the Marmeon repository in `APP_KEY` or `APP_PREVIOUS_KEYS` unless `NODE_ENV` is `development` or `test`.
- @marmeon/core@0.1.2

## 0.1.1

### Patch Changes

- f56608b: Publish every package through the release workflow, with npm provenance.
- Updated dependencies [f56608b]
  - @marmeon/core@0.1.1

## 0.1.0

### Minor Changes

- The first release (0.1.0): every package of the framework — the application kernel with constructor injection, the router, the
  page protocol and the React adapter, sessions, auth, the data layer, mail, queues, the scheduler, storage, live props, i18n, the
  devtools and OpenTelemetry — together with `create-marmeon`, all at one version.

### Patch Changes

- Updated dependencies
  - @marmeon/core@0.1.0
