# @bespokecore/devtools

What the app does, recorded while you develop — requests, queries, jobs, mails, notifications, log entries, exceptions,
scheduled runs, live hints, events and commands — as **redacted** entries in `storage/framework/devtools/` (Telescope's idea,
files instead of a table). The recorder listens to the framework's observation points (`@bespokecore/core/diagnostics`, E118);
the pages under `/_bespoke/devtools` (W7 step 8) and the in-page bar (step 9) read the entries through the store.

```sh
pnpm add -D @bespokecore/devtools     # a dev dependency: production installs do not even have it
```

`bespoke discover` registers its `DevtoolsServiceProvider` like any installed package (dev dependencies count). A production
install without dev dependencies next to a manifest written with them is fine: discovery notices the missing package and
discovers again.

## Only in development (E115, fail closed)

| | |
|---|---|
| `NODE_ENV=development` (`bespoke dev` sets it — also for its worker and scheduler) | records |
| any other `NODE_ENV` — `test`, `staging`, **unset** | nothing subscribed, nothing written, `config/devtools.ts` never loaded |
| `DEVTOOLS_ENABLED=false` | off, also in development |
| `DEVTOOLS_ENABLED=true` with `NODE_ENV=production` | **the start fails** |
| `DEVTOOLS_ENABLED=true` elsewhere | no effect (a warning at the start) |
| `createTestApp(App, { devtools: true })` | records into memory — the only way outside development (never in production) |

"Not production" is not the gate: a server without `NODE_ENV` would record everything. The commands `devtools:clear` and
`devtools:prune` exist everywhere — they only remove files.

## Settings: `config/devtools.ts` (optional)

```ts
import { defineDevtools } from '@bespokecore/devtools';

export default defineDevtools({
  record: ['requests', 'queries', 'jobs', 'mails', 'notifications', 'logs', 'exceptions', 'schedule', 'live', 'events', 'commands'], // the default: all
  ignore: {
    paths: ['/_bespoke/live'],                                   // + the defaults: /_bespoke/devtools*, Vite's /@vite/*, /@id/*, …
    queries: (query) => query.sql.startsWith('pragma'),
    commands: ['users:import'],                                  // + queue:work, schedule:work, tinker, serve, devtools:*
    events: ['auth.login'],
  },
  slowQueryMs: 100,                                              // `slow` tag and flag
  logLevel: 'debug',                                             // the least level recorded
  storage: { path: 'storage/framework/devtools', maxBytes: 50 * 1024 * 1024, maxAgeHours: 24 },   // or { driver: 'memory' }
});
```

The file is loaded **by the devtools only, and only where they run** — so it may import `@bespokecore/devtools` although the
package is a dev dependency. Nothing else imports it (do not list it in `defineApplication({ config })`).

## Entries

```ts
interface Entry {
  id: string;          // sortable by time
  type: 'request' | 'query' | 'job' | 'mail' | 'notification' | 'log' | 'exception' | 'schedule' | 'live' | 'event' | 'command';
  at: number;          // epoch ms
  batch: string;       // a request (with the islands and layer bases it resolved in-process), a job attempt, a scheduled run, a command
  requestId?: string;  // the request — also on the entries of the jobs it dispatched, run by a worker in another process (E131)
  jobId?: string;
  tags: string[];      // status:500, route:users.show, slow, failed, job:…, mailable:…, level:warn, …
  content: …;          // typed per type: RequestContent, QueryContent, JobContent, MailContent, …
}
```

| type | content |
|---|---|
| `request` | method, URL and path (sensitive route parameters and query values replaced), route, routePath, controller, status, durationMs, region, inProcess, headers and the body the app read (redacted), the page: view, **size of each prop** (bytes of JSON — never the values), `only`/`except`, deferred groups; server rendering |
| `query` | connection, driver, SQL, parameters — **none** for a statement touching secret columns (`sensitive`) —, durationMs, `slow` |
| `job` | `queued` per dispatched job (kind, delay, unique) and one per attempt (`done`, `failed`, `released`, `discarded`, attempt, durationMs, error); the payload redacted, an encrypted one only `[encrypted]` |
| `mail` | mailable, mode (`send`, `queue`, `worker`), from, to, cc, bcc, subject, HTML and text with signatures and token paths in links masked, attachments by name and size |
| `notification` | notification, id, recipient, queued, channels, outcome |
| `log` | level, message, context (redacted) — from `debug`; the database's own line per statement is left out (the query says it) |
| `exception` | class, message, stack (redacted), where (`request`, `job`, `schedule`, `command`), status/method/path, the solutions the error page shows (E130) |
| `schedule` | task, minute, reason, outcome, skipped, durationMs, error |
| `live` | channel, `only` |
| `event` | name (`static event` or class), class, its fields (redacted), listeners |
| `command` | command, arguments (redacted), exit code, durationMs |

**Batches:** a batch's entries are collected in memory and written in one go when it ends — never into the app's database,
outside of any transaction (E107). Work after a response (deferred props, `afterResponse`) joins its request's batch a moment
later. Queries outside of a request, job, run or command (a worker polling its queue, a health check) are not recorded; other
entries outside of them are written together after 100 ms. A batch keeps at most 1000 entries (the request says how many it
dropped).

## Redaction (E125) — also locally

Everything goes through the app's `Redactor` (`@bespokecore/core`) before it is written — the same one as the error page, its
Markdown and the OpenTelemetry spans: values of sensitive keys at any depth (`password`, `token`, `secret`, `cookie`,
`authorization`, `_token`, `x-xsrf-token`, `set-cookie`, the session cookie's name …), statements on tables with secret columns
without parameters, password hashes (PHC) and API tokens anywhere in text, token-like path segments (`/reset-password/<token>`
in a mail, a log line or a `Referer`), `signature=` in links, encrypted payloads as `[encrypted]`, files and bytes by their
size — and every entry cut to 64 KB.

## The store (E116)

- **Files:** NDJSON, one file per process and hour (`<YYYYMMDDHH>-<pid>-<random>-<n>.ndjson`, UTC) — the server, the worker and
  the scheduler of `bespoke dev` write into the same directory without ever appending to the same file. A file holds at most a
  tenth of `maxBytes`.
- **Ring:** 50 MB / 24 hours by default — each writing process keeps it (after a write that may have gone over, when an hour
  begins, at the start); `bespoke devtools:prune` does the same, `bespoke devtools:clear` removes everything. The web app
  schedules `devtools:prune` hourly with `.environments('development')` (the scheduler does not ask for a command limited to
  other environments, so production — without the package — starts fine).
- **Writes never fail a request:** a failed write is a process warning (once per kind) and the entries are lost.
- **Reading:** an index in memory (id, type, time, batch, request, job, tags, where the line is) over every file, brought up
  to date before each read — whole lines only, so a line another process is writing is read next time.

```ts
import { DevtoolsStore } from '@bespokecore/devtools';

const store = app.container.make(DevtoolsStore);       // bound only where the devtools run
await store.list({ type: 'request', tag: 'status:500', limit: 50 });     // newest first; also batch, requestId, jobId, search, before (paging)
await store.list({ requestId });                       // a request and what it caused — its jobs' entries, from the worker too
await store.get(id);
let { cursor } = await store.since();                  // a live tail, across processes:
({ entries, cursor } = await store.since(cursor));     // what arrived since — oldest first
await store.usage();                                   // { bytes, files, entries }
```

`MemoryStore` is the store of tests (and of `storage: { driver: 'memory' }`); `FileStore` can be built on any directory.

## Tests

```ts
const app = await createTestApp(App, { database: 'refresh', devtools: true });
const response = await app.post('/register', { form: { … } });
app.devtools.assertRecorded('query', (query) => query.sql.includes('insert into "users"'));
app.devtools.entries('request')[0]!.content.route;              // 'auth.register.store'
app.devtools.batch(entry.batch);                               // the entries of one batch
await app.queue.work();
await app.devtools.settled();                                  // what a worker recorded is written
app.devtools.assertNotRecorded('mail', (mail) => mail.to.includes('grace@example.com'));
```

A request's entries are there when the test has its response. `MailFake`, `QueueFake` and `NotificationFake` report on the
channels like the real ones, so mails, dispatches and notifications of a test are recorded too. The app must have
`@bespokecore/devtools` in its `package.json` (discovery registers the provider) — `createTestApp` says so otherwise.

## App events: the `bespoke:event` channel

The `EventDispatcher` publishes every dispatch on `bespoke:event` (`channels.subscribe(app, 'event', …)`) — before a test's
`EventFake` decides whether listeners run. The fake keeps its one observer slot; the channel is for everyone else, built only
while something listens.
