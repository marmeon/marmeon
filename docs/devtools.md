# Devtools

## Introduction

`@marmeon/devtools` is experimental: it can change in any minor release. See [the release policy](releases.md#experimental).

While you develop, the devtools record what your app does: requests, queries, jobs, mails, notifications, log entries,
exceptions, scheduled runs, live hints, events and commands. They show it at `/_marmeon/devtools`, and a small bar at the bottom
right of every page shows the requests of that page. Values that look like secrets, such as a password, a token or a link's
signature, are masked before anything is written.

A new app has them already. In another app, install the package as a dev dependency:

```sh
pnpm add -D @marmeon/devtools
```

Discovery registers it, and `marmeon dev` starts recording. Open http://localhost:3000/_marmeon/devtools while the app runs.

## Only in development

The devtools run only with `NODE_ENV=development`. `marmeon dev` sets it when neither the environment nor `.env` names a value,
for its worker and its scheduler too. Everywhere else nothing is recorded, nothing is written and the pages do not exist:

| Environment | The devtools |
| --- | --- |
| `NODE_ENV=development` | Record, and serve their pages. |
| `NODE_ENV=test`, `production` with any `APP_ENV`, or no `NODE_ENV` | Off. Their routes answer `404`, and the start does not load `config/devtools.ts`. |
| `DEVTOOLS_ENABLED=false` | Off, also in development. |
| `DEVTOOLS_ENABLED=true` where the app is protected | The start fails. |
| `createTestApp(application, { devtools: true })` | Record into memory, for the test. |

The rule asks for development, not for "anything but production": a server whose `NODE_ENV` was forgotten records nothing.
`DEVTOOLS_ENABLED=true` cannot turn them on anywhere else, and with `production` or no `NODE_ENV` it stops the start
instead of being ignored. With `NODE_ENV=test` it has no effect, and the start logs a warning.

> [!WARNING]
> A developer's `.env` with `NODE_ENV=development` copied to a server would turn the devtools on there. `marmeon start` refuses
> to run when `development` comes from a `.env`. Keep the package a dev dependency: a production install without dev
> dependencies does not even have it.

The commands `devtools:clear` and `devtools:prune` exist wherever the package is installed. They only remove files: in
development in the directory that `config/devtools.ts` names, anywhere else in the default directory, `storage/framework/devtools`.
They load `config/devtools.ts` in development only, as the devtools do.

## What they record

Each recording is an entry with a type, a time, tags to filter by, and the request or job it belongs to:

| Type | What an entry holds |
| --- | --- |
| `request` | Method, URL, route, controller, status, time, the headers and the input the app read, the page with the size of each prop, server rendering. |
| `query` | Connection, SQL, parameters, time, and the `slow` flag. |
| `job` | Each dispatch, and each attempt with its outcome, time and error. The payload, redacted. |
| `mail` | The mailable, whether it was sent or queued, the addresses, the subject, the text and the HTML, the attachments by name and size. |
| `notification` | The notification, the recipient, the channels and the outcome. |
| `log` | Level, message and context. |
| `exception` | Class, message, stack, where it happened, and the solutions the error page shows. |
| `schedule` | Each run of a scheduled task, with its outcome. |
| `live` | Each hint: the channel and the props it names. |
| `event` | Each event with its fields and the listeners it reached. |
| `command` | Each `marmeon` command with its arguments and exit code. |

A request records the size of each prop, never the values. A redirect shows its target, and the protocol's `409` after a sign-in
or a new build shows as a full reload, not as an error. Work outside a request, job, scheduled run or command, such as a worker
polling its queue or a health check, records no queries.

Entries of one request share a batch: its queries, its log entries, the jobs it queued, its mails. A job that a worker runs later
keeps the id of the request that dispatched it, so the request's page shows what it set off in the worker too.

## Redaction

Everything passes the app's redactor before it is written, also on your own machine. It masks by the name of a field and by the
shape of a text:

- the values of keys that look like secrets, at any depth, for example `password`, `token`, `secret`, `cookie`, `authorization`,
  `api_key`, `remember`, `signature`, `_token`, `set-cookie` and the session cookie's name;
- no parameter at all of a statement that touches a table with [secret columns](migrations.md#secret-columns);
- password hashes and API tokens anywhere in text, token-like path segments such as `/reset-password/<token>`, and `signature=`
  in links;
- an encrypted job payload as `[encrypted]`, and files and bytes by their size;
- every entry cut at 64 KB.

So a recorded mail with a reset link shows the link with the token masked, and a sign-in shows `password: [redacted]`. The
[logging](logging.md#what-the-framework-shows-elsewhere) page explains what each part of the framework masks.

Everything else is recorded as it is: input under other names, such as `card_number` or `iban`, headers such as `Referer`, the
parameters of statements on ordinary tables, job and event payloads, and the full text and HTML of every mail, so a one-time code
in a mail body shows. The entries are plain-text files in `storage/framework/devtools/`, which a new app's `.gitignore` keeps out
of Git. Do not record real personal data in development. Data that must never show belongs in a column marked `secret()`, a job
marked as encrypted, or a field whose name the redactor knows, which `app.container.make(Redactor).addKeys('card_number')` in a
provider's `boot()` adds.

## Settings

The defaults record everything. To change that, add `config/devtools.ts` with every option you need:

```ts title="config/devtools.ts"
import { defineDevtools } from '@marmeon/devtools';

export default defineDevtools({
  record: ['requests', 'queries', 'jobs', 'mails', 'logs', 'exceptions'],
  ignore: {
    paths: ['/_marmeon/live', '/notes/export*'],
    queries: (query) => query.sql.startsWith('pragma'),
    commands: ['users:import'],
    events: ['notes.viewed'],
  },
  slowQueryMs: 50,
  logLevel: 'info',
  storage: { maxBytes: 100 * 1024 * 1024, maxAgeHours: 48 },
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `record` | everything | What to record: `requests`, `queries`, `jobs`, `mails`, `notifications`, `logs`, `exceptions`, `schedule`, `live`, `events`, `commands`. |
| `ignore.paths` | the devtools' own pages, Vite's paths | More requests to leave out, with everything of their batch. An exact path, a prefix ending in `*`, or a regular expression. |
| `ignore.queries` | none | A function that leaves out a statement. |
| `ignore.commands` | `queue:work`, `schedule:work`, `tinker`, `serve` and the devtools' own | More commands to leave out. |
| `ignore.events` | none | Events left out, by their `static event` name or class name. |
| `slowQueryMs` | `100` | A statement that takes at least this long is tagged `slow`. |
| `logLevel` | `'debug'` | The least level of a log entry that is recorded. |
| `storage` | `{ path: 'storage/framework/devtools', maxBytes: 50 MB, maxAgeHours: 24 }` | Where the files go and how much they keep. `{ driver: 'memory' }` keeps entries in the process only. |

The file is loaded by the devtools, and only where they run, so it may import `@marmeon/devtools` although the package is a dev
dependency. That is also why it is the one configuration file outside `defineApplication({ config })`: listed there, a
production install without the package could not start. A file that does not `export default defineDevtools({ … })` stops the
start, and so does an unknown name in `record`.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEVTOOLS_ENABLED` | not set | `false` turns the devtools off in development. `true` changes nothing, and stops the start where the app is protected. |

## Where the entries live

The entries are files in `storage/framework/devtools/`, one file per process and hour. The server, the worker and the scheduler
of `marmeon dev` write into the same directory, and the pages show them together. The files form a ring: by default 50 MB and 24
hours. Each process that writes keeps the ring within its limits, and two commands help:

```sh
pnpm marmeon devtools:prune   # removes entries past the age, then the oldest until the size fits
pnpm marmeon devtools:clear   # removes every entry
```

An app that runs its scheduler in development can prune every hour, limited to development so that production never asks for
the command:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('devtools:prune').hourlyAt(40).environments('local');
});
```

Entries are written when their request, job, run or command ends, never into the app's database and never inside a transaction.
A write that fails never fails the request: it is a warning, and the entries are lost. A batch keeps at most 1000 entries, and
the request says how many it dropped.

## The pages

`/_marmeon/devtools` opens with an overview: the latest requests as they come, exceptions, slow queries, failed job attempts,
the queue, and warnings such as a store near its limit. Each type has its list:

| Path | What it shows |
| --- | --- |
| `/_marmeon/devtools/requests` | Requests, newest first. A request's page shows its route, controller, props by size, headers, input, queries, log entries, and what it set off. |
| `/_marmeon/devtools/queries`, `/jobs`, `/mails`, `/notifications`, `/logs`, `/exceptions`, `/events`, `/live`, `/commands` | The entries of that type. |
| `/_marmeon/devtools/schedule` | The scheduled tasks with their next run, and the latest runs. |
| `/_marmeon/devtools/queue` | Every queue's waiting, delayed and running jobs, and the failed jobs. |
| `/_marmeon/devtools/batches/:batch` | Everything one request, job attempt, run or command recorded, in order. |

The lists update while you watch, and filter by tag, request id or a search: `?status=4xx&route=notes.store&search=milk`.
`/_marmeon/devtools/requests/<x-request-id>` leads to a request by the id of its response. A mail's HTML shows in a sandboxed
frame that runs no script. The [mail previews](mail.md#previews) at `/_marmeon/mail` are linked from the navigation.

The pages run nothing. Retrying a failed job or running a task is a command to copy, such as `marmeon queue:retry 42`, shown next
to the entry.

### How the pages are protected

- **Development only.** The routes exist only where the devtools run. Elsewhere they are not registered.
- **Local hosts only.** A request whose `Host` is not `localhost`, `127.0.0.1`, `[::1]` or the host of `APP_URL` gets `403`. This
  stops DNS rebinding: a page on another site that points its own name at your machine cannot read the devtools. The
  [security](security.md#development-routes) page explains the guard all development routes share.
- **Read only.** Every route answers `GET` only, and none changes anything.
- **No session, no cookies.** The routes belong to no middleware group.
- **Strict headers.** Every answer is `no-store` and `nosniff`, has a strict `Content-Security-Policy` of its own that only this
  origin may frame, and is shared with no other origin.
- **Escaped.** Every value is escaped, so a `<script>` in a recorded path or log line shows as text.

## The bar on every page

Every page that `marmeon dev` renders gets a pill at the bottom right: **Marmeon**, the kind, status and time of the last
request, and a red dot after a failed request or a hydration error. A click or `Alt+Shift+D` opens a panel with six tabs:

| Tab | What it shows |
| --- | --- |
| Visits | Every request the page's client made: visits, partial reloads, deferred props, prefetches, layers, islands, actions, live validations, uploads, and the live hints that came. |
| Page | The page on screen and each layer: component, route, controller, query, and every prop with its size and how it arrived. |
| Layers & regions | The stack of layers and the islands of each, with their status. |
| Optimistic | Each optimistic change of an action: what it changed and how it ended. |
| Server | What the server recorded for a request: queries, log entries, events, jobs, mails. |
| SSR | The server rendering of the document, and the hydration errors React recovered from. |

The component and the controller have an "open in editor" link through Vite. The bar exists only under the Vite dev server: it
is added to the document's head in development and comes from the Vite dev server, so no build contains it. It keeps what it
saw only for the current document: after a sign-in or sign-out, or a new build, it starts empty. It never stores props. The
browser's session storage holds only whether the panel is open and which tab is chosen.

## For other tools

The bar reads the same data any tool can: JSON under `/_marmeon/devtools/api`, with the same guard and headers as the pages.

| Request | Answer |
| --- | --- |
| `GET /_marmeon/devtools/api` | `{ version: 1, types, endpoints }` |
| `GET /_marmeon/devtools/api/entries?type=&tag=&requestId=&search=&before=&limit=` | `{ entries, next }`, newest first. `next` pages on. |
| `GET /_marmeon/devtools/api/entries/:id` | `{ entry }` |
| `GET /_marmeon/devtools/api/requests/:requestId` | Everything of one request, the worker's entries included, oldest first. |
| `GET /_marmeon/devtools/stream` | Server-Sent Events: an `entry` event for each new entry of any process. |

Every entry in the answers is redacted like the pages. `GET /_marmeon/devtools/api` lists the other endpoints, for the queue,
the schedule, a batch and the location of a controller's source.

## Testing

A test records with `devtools: true`, into memory, and `app.devtools` reads the entries:

```ts title="modules/notes/devtools.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('records a registration without the password', async () => {
  const app = await createTestApp(application, { database: 'refresh', devtools: true });
  const password = 'correct horse battery';
  await app.post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password, password_confirmation: password } });

  const request = app.devtools.assertRecorded('request', (content) => content.route === 'auth.register.store');
  expect(request.content.input).toMatchObject({ email: 'ada@example.com', password: '[redacted]' });
  app.devtools.assertRecorded('query', (query) => query.sql.startsWith('insert into "users"') && query.sensitive);

  await app.queue.work();
  await app.devtools.settled();
  expect(JSON.stringify(app.devtools.entries())).not.toContain(password);
});
```

| Member | What it does |
| --- | --- |
| `entries(type)` | The entries so far, of one type when given, oldest first. |
| `batch(id)` | The entries of one batch. |
| `assertRecorded(type, predicate)` | Returns the first entry whose content passes, or fails with what was recorded. |
| `assertNotRecorded(type, predicate)` | Fails when an entry passes. |
| `settled()` | Waits until everything recorded so far is written, such as the entries of jobs `work()` ran. |
| `clear()` | Forgets every entry. |

A request's entries are there when the test has its response. The mail, queue and notification fakes report like the real
services, so a test records their mails, jobs and notifications too. The test does not read `config/devtools.ts`: it records
everything. The app must have `@marmeon/devtools` in its `package.json`, and a test that opts in where the app is protected, with
`NODE_ENV=production` for example, fails at the start.
