# Packages

## Introduction

Marmeon is a set of packages that are released together. A new app depends on most of them already, and you add the others when
you need what they bring. Each installed package registers itself through [discovery](modules.md#discovery), so adding one is a
single command, in the version your app already has:

```sh
pnpm marmeon add redis
```

Without `marmeon add` (yarn, bun, a workspace), install it yourself: `pnpm add -E @marmeon/redis@<version of your app>`.

Every package has the same version as every other: upgrade them together. Each pins the others exactly, so one in another version
(`pnpm add @marmeon/redis` takes `latest`, which an app on a release candidate is not) brings a second copy of `@marmeon/core`, and the package
manager's only sign is a warning about peers. `-E` saves the version exactly. A new app saves exactly by itself (`saveExact: true` in `pnpm-workspace.yaml`, `save-exact=true` in `.npmrc` for npm); an app that is older can set it too. [`marmeon check`](check.md#the-packages-check)
finds a package in another version, and `marmeon dev` warns about it at the start. The [release policy](releases.md) explains why.

## What a new app has

`pnpm create marmeon` installs these packages:

| Package | What it brings | Read more |
| --- | --- | --- |
| `@marmeon/core` | The application, modules, service providers, the container, configuration, events and the clock. | [Modules](modules.md), [container](container.md), [providers](providers.md), [configuration](configuration.md), [events](events.md) |
| `marmeon` | The command: `dev`, `build`, `start`, the generators and `tinker`. | [Console](console.md), [deployment](deployment.md) |
| `@marmeon/router` | Routes, invokable controllers, requests with schemas, route model binding and middleware. | [Routing](routing.md), [controllers](controllers.md), [requests](requests.md), [middleware](middleware.md) |
| `@marmeon/http` | Controllers, pages and their props, redirects, signed URLs, cookies, and the browser's side of every visit. | [Responses](responses.md), [pages](pages.md), [URL generation](urls.md) |
| `@marmeon/server` | The HTTP server, server rendering, health checks and the graceful stop. | [Request lifecycle](lifecycle.md), [health checks](health.md) |
| `@marmeon/session` | Sessions with their drivers, flash data and CSRF protection. | [Session](session.md), [CSRF protection](csrf.md) |
| `@marmeon/encryption` | Encryption with `APP_KEY` and key rotation, behind every cookie and session. | [Encryption](encryption.md) |
| `@marmeon/validation` | The validation rules, with messages in the request's language. | [Validation](validation.md) |
| `@marmeon/i18n` | Translations, the request's language and formatting. | [Localization](localization.md) |
| `@marmeon/database` | Connections, migrations, table types, repositories, factories, transactions and pagination. | [Database](database.md), [repositories](queries.md), [migrations](migrations.md) |
| `@marmeon/cache` | The cache, atomic locks and rate limits. | [Cache](cache.md), [rate limiting](rate-limiting.md) |
| `@marmeon/auth` | Sign-in, password hashing and reset, the confirmation of an address, API tokens, policies and `make:auth`. | [Authentication](authentication.md), [authorization](authorization.md), [starter kit](starter-kit.md) |
| `@marmeon/mail` | Mails as classes, queued sending and previews. | [Mail](mail.md) |
| `@marmeon/queue` | Jobs, workers, retries and failed jobs. | [Queues](queues.md) |
| `@marmeon/scheduler` | Scheduled tasks. | [Task scheduling](scheduling.md) |
| `@marmeon/storage` | Disks on the local file system or S3, signed URLs and uploads. | [File storage](storage.md) |
| `@marmeon/live` | Live updates: pages reload their data when the server hints a change. | [Real-time updates](realtime.md) |
| `@marmeon/notifications` | Notifications over mail, the database and live updates. | [Notifications](notifications.md) |
| `@marmeon/fetch` | Outgoing HTTP requests that refuse addresses that are not public, with a fake for tests. | [HTTP client](http-client.md) |
| `@marmeon/log` | The logger: readable in development, JSON in production. | [Logging](logging.md) |
| `@marmeon/react` | The React side: pages, layouts, `<Link>`, forms, islands and dialogs. | [Pages](pages.md), [navigation](navigation.md), [forms](forms.md) |

As dev dependencies, a new app has three more:

| Package | What it brings | Read more |
| --- | --- | --- |
| `@marmeon/vite` | The Vite plugin: the entries, the injection lists and the check that keeps server code out of the browser. | [Asset bundling](vite.md) |
| `@marmeon/testing` | `createTestApp()`, requests and assertions, the database refresh and the fakes. | [Testing](testing.md), [fakes](fakes.md) |
| `@marmeon/devtools` | What the app did while you develop: requests, queries, jobs and mails. Development only. | [Devtools](devtools.md) |

## Packages you add

| Package | What it brings | Read more |
| --- | --- | --- |
| `@marmeon/redis` | Redis connections for the cache, sessions, the queue and live updates. | [Redis](redis.md) |
| `@marmeon/table` | Data tables driven by the server: columns, sorting, filters, actions and CSV export. | [Data tables](tables.md) |
| `@marmeon/oauth` | Social login: OAuth 2.0 and OpenID Connect providers you register by name, linked accounts and `make:oauth`. | [Social login](oauth.md) |
| `@marmeon/otel` | OpenTelemetry traces of requests, queries, jobs and mails. | [Observability](observability.md) |

Add one with `marmeon add`, which installs it at the version of your app:

```sh
pnpm marmeon add redis
```

The command takes the short name (`redis`) or the full one (`@marmeon/redis`), and no version. It does four things:

1. It installs the package with your package manager (pnpm or npm, by your lockfile) at exactly the version of your app, as a
   development dependency for `devtools`, `testing` and `vite`.
2. It runs `marmeon discover`, so the app finds the package's provider.
3. It copies the migrations of a package that ships some (`auth`, `cache`, `live`, `notifications`, `queue`, `session`, `storage`)
   with `marmeon publish`. That boots the app, so it needs a `.env` the app boots with.
4. It prints the next step: `marmeon migrate` after a publish, and the `marmeon docs` page of each package.

`marmeon add redis --dry-run` prints the commands and changes nothing. If the install fails or you press Ctrl-C, `package.json` and
the lockfile are put back as they were; run `pnpm install` to bring `node_modules` back. A pnpm that stops because a dependency's
build script is not approved (`ERR_PNPM_IGNORED_BUILDS`) needs `pnpm approve-builds` first.

Once the install has finished, its files stay as it left them, even when a later step fails: when the package manager installed another
version than your app's (a release the package manager holds back for its first day, for example), or when `discover` or `publish`
fails. The command then says what to run.

`marmeon add` refuses when it cannot be sure of the result: your framework packages are not all in one version, one comes from a
workspace, a path or a patch rather than the registry, the package is listed only under `peerDependencies`, the app is part
of a workspace, it has no lockfile or one of another package manager, `package.json` cannot be read, or anything else the command
names. It then says what to change. With yarn or bun, or in a workspace, install the package yourself at the version of your
app (`pnpm add -E @marmeon/redis@<version of your app>`) and run `marmeon discover`, and `marmeon publish <package>` for a package
with migrations.

A package that needs a library of its own names the exact install command when the library is missing. The
[deployment](deployment.md#drivers-what-an-app-installs) page lists them.

## The creator

`create-marmeon` is the package behind `pnpm create marmeon`. It writes a new app and is not a dependency of it. The
[installation](installation.md) page covers its questions and options.
