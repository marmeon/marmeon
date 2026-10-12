# Why Marmeon

## Introduction

Marmeon is built by [BespokeCode](https://bespokecode.de), a software company in Munich that builds tailor-made web applications for
its clients. This page explains why BespokeCode made a framework, what it stands for, and why it is open source.

## Where it comes from

Project after project needed the same foundation: sign-in, sessions, validation, mail, queues, scheduled tasks, translations,
security headers and CSRF protection. We assembled it each time from separate libraries, and each library had its own
conventions. The types broke at the seams between them, and every project made the same security decisions again.

Marmeon is that foundation, built once, in one place. It is the one we want to build our clients' applications on.

## What it stands for

These are the principles every part of the framework follows, and each links to the page that shows it:

- **Typed end to end.** Types run from the database column through the controller, validation and route names to the form error
  in the React component. See [routing](routing.md), [validation](validation.md) and [forms](forms.md).
- **No global state.** There are no singletons holding request data: one application, and a scope per request or job. See the
  [container](container.md) and the [request lifecycle](lifecycle.md).
- **TypeScript runs natively on Node.** There is no transpile step and there are no decorators: constructor injection works from
  generated lists. See [installation](installation.md) and the [container](container.md).
- **Modules first.** A module brings its routes, providers, migrations, views and tests, and installed packages register
  themselves. See [modules](modules.md).
- **One endpoint, one class.** Controllers, jobs, listeners, commands, mails and policies are classes with `handle()`. See
  [controllers](controllers.md).
- **Batteries included, behind contracts.** Services that talk to the outside world have several drivers, and mail, the queue,
  notifications, storage, events, live updates and the schedule have a fake for tests. See [packages](packages.md) and [fakes](fakes.md).
- **Secure by default.** Protections fail closed outside development, page data never lands in the browser's storage, and
  signed-in pages are never cached. See the [security overview](security.md).

## Why it is open source

Marmeon is free software under the MIT licence. A foundation gets better and safer when more people build on it and report what
breaks. If you find a bug, a gap in the docs or a security problem, we want to hear about it. The
[contribution guide](../CONTRIBUTING.md) explains how, and the [security policy](../SECURITY.md) says how to report a
vulnerability.

## Who is behind it

BespokeCode builds Marmeon and keeps it up to date. If you want an application built on Marmeon, or help with your own,
[BespokeCode](https://bespokecode.de) can do that.
