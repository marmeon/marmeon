# Packages

## Introduction

Marmeon is a set of packages that are released together. A new app depends on most of them already, and you add the others when
you need what they bring. Each installed package registers itself through [discovery](modules.md#discovery), so adding one is a
single command:

```sh
pnpm add @marmeon/redis
```

Every package has the same version as every other: upgrade them together. The [release policy](releases.md) explains why.

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
| `@marmeon/storage` | Disks on the local file system or S3, signed URLs and uploads. | [File storage](storage.md) |
| `@marmeon/live` | Live updates: pages reload their data when the server hints a change. | [Real-time updates](realtime.md) |
| `@marmeon/notifications` | Notifications over mail, the database and live updates. | [Notifications](notifications.md) |
| `@marmeon/table` | Data tables driven by the server: columns, sorting, filters, actions and CSV export. | [Data tables](tables.md) |
| `@marmeon/otel` | OpenTelemetry traces of requests, queries, jobs and mails. | [Observability](observability.md) |

A package that needs a library of its own names the exact install command when the library is missing. The
[deployment](deployment.md#drivers-what-an-app-installs) page lists them.

## The creator

`create-marmeon` is the package behind `pnpm create marmeon`. It writes a new app and is not a dependency of it. The
[installation](installation.md) page covers its questions and options.
