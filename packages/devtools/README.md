# @bespokecore/devtools

What the app does, recorded while you develop — requests, queries, jobs, mails, notifications, log entries, exceptions,
scheduled runs, live hints, events and commands — as **redacted** entries in `storage/framework/devtools/` (Telescope's idea,
files instead of a table). The recorder listens to the framework's observation points
([`@bespokecore/core/diagnostics`](../core/README.md#diagnostics-bespokecorecorediagnostics-e118), E118);
the pages under [`/_bespoke/devtools`](#the-pages-_bespokedevtools) (W7 step 8) and the [in-page bar](#the-in-page-bar) (step 9)
read the entries through the store.

```sh
pnpm add -D @bespokecore/devtools     # a dev dependency: production installs do not even have it
```

`bespoke discover` registers its `DevtoolsServiceProvider` like any installed package (dev dependencies count). A production
install without dev dependencies next to a manifest written with them is fine: discovery notices the missing package and
discovers again — in memory, with one warning, when `.bespoke/` is read-only (E160); `make:docker`'s image runs `bespoke discover`
after its production install.

## Only in development (E115, fail closed)

| | |
|---|---|
| `NODE_ENV=development` — from the environment or the app's `.env` (E170); `bespoke dev` sets it when neither has one, also for its worker and scheduler | records |
| any other `NODE_ENV` — `test`, `staging`, **unset** | nothing subscribed, nothing written, `config/devtools.ts` never loaded |
| `DEVTOOLS_ENABLED=false` | off, also in development |
| `DEVTOOLS_ENABLED=true` where the app is protected — `production`, `staging`, **unset** (E139) | **the start fails** |
| `DEVTOOLS_ENABLED=true` with `NODE_ENV=test` | no effect (a warning at the start) |
| `createTestApp(App, { devtools: true })` | records into memory — the only way outside development (never where the app is protected) |

"Not production" is not the gate: a server without `NODE_ENV` would record everything. A developer's `.env` copied to a server
(`NODE_ENV=development`) would open it there too — `bespoke start` warns loudly about it
([where it comes from](../core/README.md#the-environment-node_env)), and a production install without dev dependencies has no
devtools to open. The commands `devtools:clear` and `devtools:prune` exist everywhere — they only remove files.

## Settings: `config/devtools.ts` (optional)

Two parts, read by the `DevtoolsServiceProvider`:

- **The gate** — `DevtoolsConfig`, the package's config class, from the environment: `NODE_ENV`, `DEVTOOLS_ENABLED` (see
  [the table above](#only-in-development-e115-fail-closed)) and `APP_URL` (its host may open the pages, besides the loopback
  names — [security model](#security-model)).
- **What to record** — `config/devtools.ts`, a **convention file**: the provider looks for it at that path in the app's root
  and loads it itself, once the gate is open. It is the only config of the app **outside `defineApplication({ config })`** —
  because the package is a dev dependency: listed there, the app's composition root would import `@bespokecore/devtools`, and a
  production install (without dev dependencies) could not even load it. The file is optional (the defaults below apply); if it
  exists it must `export default defineDevtools({ … })`, or the start fails with a `DevtoolsConfigError`.

```ts
// config/devtools.ts — every option; record, slowQueryMs, logLevel and storage as they default
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

The file is loaded **by the devtools only, and only where they run** — so it may import `@bespokecore/devtools` although the package
is a dev dependency; nothing else imports it. `ignore.paths` takes an exact path, a prefix ending in `*` or a `RegExp`; an unknown
name in `record` fails at `defineDevtools()`. A test's opt-in (`devtools: true`) does not read the file: it records everything, into
memory.

## Entries

```ts
interface Entry {
  id: string;          // sortable by time
  type: 'request' | 'query' | 'job' | 'mail' | 'notification' | 'log' | 'exception' | 'schedule' | 'live' | 'event' | 'command';
  at: number;          // epoch ms
  batch: string;       // a request (with the islands and layer bases it resolved in-process), a job attempt, a scheduled run, a command
  requestId?: string;  // the request — also on the entries of the jobs it dispatched, run by a worker in another process (E131)
  jobId?: string;
  tags: string[];      // status:500, status:5xx, route:users.show, reload, slow, failed, job:…, mailable:…, level:warn, …
  content: …;          // typed per type: RequestContent, QueryContent, JobContent, MailContent, …
}
```

| type | content |
|---|---|
| `request` | method, URL and path (sensitive route parameters and query values replaced), route, routePath, controller, status, durationMs, `location` (a redirect's target, or the protocol's 409 reload with its `reload` reason: `version`, `history`), region, inProcess, headers and the body the app read (redacted), the page: view, **size of each prop** (bytes of JSON — never the values), `only`/`except`, deferred groups; server rendering |
| `query` | connection, driver, SQL, parameters — **none** for a statement touching secret columns (`sensitive`) —, durationMs, `slow` |
| `job` | `queued` per dispatched job (kind, delay, unique) and one per attempt (`done`, `failed`, `released`, `discarded`, attempt, durationMs, error); the payload redacted, an encrypted one only `[encrypted]` |
| `mail` | mailable, mode (`send`, `queue`, `worker`), from, to, cc, bcc, subject, HTML and text with signatures and token paths in links masked, attachments by name and size |
| `notification` | notification, id, recipient, queued, channels, outcome |
| `log` | level, message, context (redacted) — from `debug`; the database's own line per statement is left out (the query says it) |
| `exception` | class, message, stack (redacted), where (`request`, `job`, `schedule`, `command`), status/method/path, the solutions the error page shows ([E130](../core/README.md#solutions-e130)) |
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

Everything goes through the app's `Redactor` ([redaction](../core/README.md#redaction-e125)) before it is written — the same one as
the error page, its Markdown and the OpenTelemetry spans: values of sensitive keys at any depth (`password`, `token`, `secret`,
`cookie`, `authorization`, `_token`, `x-xsrf-token`, `set-cookie`, the session cookie's name …), statements on tables with secret
columns without parameters, password hashes (PHC) and API tokens anywhere in text, token-like path segments
(`/reset-password/<token>` in a mail, a log line or a `Referer`), `signature=` in links, encrypted payloads as `[encrypted]`, files
and bytes by their size — and every entry cut to 64 KB.

## The store (E116)

- **Files:** NDJSON, one file per process and hour (`<YYYYMMDDHH>-<pid>-<random>-<n>.ndjson`, UTC) — the server, the worker and
  the scheduler of `bespoke dev` write into the same directory without ever appending to the same file. A file holds at most a
  tenth of `maxBytes`.
- **Ring:** 50 MB / 24 hours by default — each writing process keeps it (after a write that may have gone over, when an hour
  begins, at the start); `bespoke devtools:prune` does the same, `bespoke devtools:clear` removes everything. The web app
  schedules `devtools:prune` hourly with `.environments('development')` ([@bespokecore/scheduler](../scheduler/README.md): it
  does not ask for a command limited to other environments, so production — without the package — starts fine).
- **Writes never fail a request:** a failed write is a process warning (once per kind) and the entries are lost.
- **Reading:** an index in memory (id, type, time, batch, request, job, tags, where the line is) over every file, brought up
  to date before each read — whole lines only, so a line another process is writing is read next time.

```ts
import { DevtoolsStore } from '@bespokecore/devtools';

const store = app.container.make(DevtoolsStore);       // bound only where the devtools run
await store.list({ type: 'request', tag: 'status:500', limit: 50 });     // newest first; also batch, requestId, jobId, search, before (paging)
await store.list({ type: ['request', 'mail'], tag: ['status:4xx', 'route:auth.login'] });   // several types; every tag must match
await store.list({ requestId });                       // a request and what it caused — its jobs' entries, from the worker too
await store.get(id);
let { cursor } = await store.since();                  // a live tail, across processes:
({ entries, cursor } = await store.since(cursor));     // what arrived since — oldest first
await store.usage();                                   // { bytes, files, entries }
```

`MemoryStore` is the store of tests (and of `storage: { driver: 'memory' }`); `FileStore` can be built on any directory.

## The pages: `/_bespoke/devtools`

Served by the app itself, rendered on the server (E117) with the escaping
[`html` template](../core/README.md#html-the-escaping-html-template) — own CSS, light
and dark, one small inline script for the live tail, filters and copy buttons; no client framework, **nothing of it in the
app's Vite bundle** (the leak test looks for the devtools in every client chunk). Every page `bespoke dev` renders carries the
[in-page bar](#the-in-page-bar), which links here.

| Path | What it shows |
|---|---|
| `/_bespoke/devtools` | Overview: latest requests (live), exceptions, slow queries, failed job attempts, queue size and failed jobs, the store's size — and warnings: the scheduler's lock warning (E123), injection warnings (E128), a store near its limit |
| `/requests`, `/requests/:id` | A request: status as the protocol means it (**409 + location = full reload**, after signing in or out or a new build — shown as `409 reload`, not as an error; a redirect with its target; live validations, actions, partial reloads, prefetches, islands and layers marked), route, pattern, controller, server rendering, the page's view and **each prop's size**, `only`/`except`/deferred, headers, query, input — its queries and log, what else it recorded (jobs queued, mails, events, live hints) and **what it set off**: the job attempts a worker ran for it, by the request id (E131). `/requests/<x-request-id>` leads to the request's page too. |
| `/queries`, `/jobs`, `/mails`, `/notifications`, `/logs`, `/exceptions`, `/events`, `/live`, `/commands` (each `[/:id]`) | The type's list — newest first, live, filtered by tag, request id, search; paged — and an entry's page: its content, its batch, its request and job |
| `/mails/:id` | A recorded mail: envelope, text, and its HTML in a **sandboxed frame** (`sandbox` without `allow-scripts`, from `/mails/:id/html`, which carries `Content-Security-Policy: sandbox` itself) |
| `/schedule` | The scheduled tasks — schedule, next run (the logic of `schedule:list`), options, `bespoke schedule:test <task>` to copy — the lock warning (E123), and the latest runs |
| `/queue` | Horizon's idea, development only (E113) — the counts of [@bespokecore/queue](../queue/README.md#connections-and-drivers): every connection's queues with their jobs (ready, delayed, running), the failed jobs (error and payload redacted) with `bespoke queue:retry <id>` / `queue:forget <id>` **to copy**, the latest attempts — read through the queue's own connections, outside any transaction |
| `/batches/:batch` | Everything one request, job attempt, run or command recorded, in order |
| `/stream` | Server-Sent Events: the live tail (see below) |
| `/api/*` | JSON for the in-page bar and other tools (see below) — `/api/source` too: where a controller or a view is, for "open in editor" |
| `/_bespoke/mail` | The mail previews ([previews](../mail/README.md#previews-e106), E106), linked in the navigation — same gate: development only |

Filters (`?status=4xx&route=auth.login&tag=failed&requestId=…&search=…`) are plain links and forms; `/` focuses the search.

### Security model

- **Gate (E115):** the routes exist only where the devtools run — `NODE_ENV=development` (or a test's `devtools: true`). In
  production, staging, tests without the opt-in or without `NODE_ENV` they are **not registered** (404); `DEVTOOLS_ENABLED=true`
  where the app is protected (production, staging, no `NODE_ENV`) fails the start.
- **Host check (DNS rebinding):** a request whose `Host` is not `localhost`, `127.0.0.1`, `[::1]` or the host of `APP_URL` gets
  **403** — a page on `evil.example` whose name was pointed at 127.0.0.1 cannot read the devtools as same-origin. In `bespoke dev`
  Vite's own host check (`server.allowedHosts`) runs first, for the whole app: a host Vite does not know (the `APP_URL` host
  included, unless the app's Vite config allows it) gets Vite's 403. No CORS header is ever set.
- **Read-only, GET only:** no route accepts POST, PUT, PATCH or DELETE, and none runs anything (E113, E130) — retrying a failed
  job, running a task, clearing the store are commands to copy.
- **No session, no cookies:** the routes are in no middleware group (no session, no CSRF, nothing written).
- **Headers:** `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src/script-src` the pages' own
  inline code by hash; `img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'self'` (only this origin may frame them), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy`/`-Opener-Policy: same-origin`, `X-Robots-Tag: noindex` — on every answer, the 403 and the
  error answers included (one without a policy of its own gets `frame-ancestors 'self'`). An app's
  [`contentSecurityPolicy()`](../http/README.md#content-security-policy-e147) leaves this policy alone (a response's own is kept).
- **Escaping:** what the entries hold is redacted already (E125); the pages still escape every value — a `<script>` in a
  recorded path, query or log line is text. A recorded mail's HTML is shown only in the sandboxed frame (opaque origin, no
  scripts, inline styles and images only).

### JSON API (version 1) and the stream — for the in-page bar (step 9) and other tools

Same gate, host check and headers as the pages. Every entry is the `Entry` above (redacted).

| Request | Answer |
|---|---|
| `GET /_bespoke/devtools/api` | `{ version: 1, types, endpoints }` |
| `GET /_bespoke/devtools/api/status` | `{ version, usage: { bytes, files, entries }, maxBytes?, types }` |
| `GET /_bespoke/devtools/api/entries?type=&tag=&requestId=&jobId=&batch=&search=&before=&limit=` | `{ entries, next }` — newest first; `type` and `tag` may repeat (`type=request,mail` too), every tag must match; `next` is the `before` of the next page (`null` at the end); an unknown type is a 400 |
| `GET /_bespoke/devtools/api/entries/:id` | `{ entry }` or 404 |
| `GET /_bespoke/devtools/api/requests/:requestId` | `{ requestId, entries, batches }` — everything of one request by its `x-request-id`, **oldest first**: its own batch and what its jobs recorded in a worker (E131) |
| `GET /_bespoke/devtools/api/batches/:batch` | `{ batch, entries }` — oldest first |
| `GET /_bespoke/devtools/api/queue` | `{ available: true, default, connections: [{ connection, driver, queues: [{ name, size, ready, delayed, reserved }], error? }], failed: [{ id, job, connection, queue, failedAt, exception, payload, requestId?, retry, forget }], failedTotal }` — or `{ available: false, reason }` |
| `GET /_bespoke/devtools/api/schedule` | `{ available: true, tasks: [{ name, expression, timeZone, summary, next?, options, test }], warning?, runs }` — or `{ available: false, reason }` |
| `GET /_bespoke/devtools/api/source?controller=<Class>` · `?view=<module/Page>` | `{ file, display, line, editor }` or 404 — where `export class <Class>` is in the app's `modules/**` (`app/**`), or the view's file (`modules/<module>/views/<Page>.tsx`); `editor` is Vite's `/__open-in-editor?file=<file>:<line>`. Read only, inside the app's root only (a class name, a view name of word characters — nothing else is looked for) |
| `GET /_bespoke/devtools/stream?type=&tag=&requestId=&jobId=&batch=&search=` | `text/event-stream`: `retry: 2000`, `event: ready` (`{ version }`), then `event: entry` with `data: { "entry": … }` for each new entry of **any process** (server, worker, scheduler — the store is polled every 250 ms), comment heartbeats every 15 s; `rows=1` adds `row`, the list row the pages insert. It starts with what arrives from now on and ends when the server closes. |

## The in-page bar

Every page `bespoke dev` renders gets a pill at the bottom right — **BespokeCore**, the last request's kind, status and time, a
red dot after a hydration error or a failed request. A click or **`Alt+Shift+D`** opens the panel (W7 step 9, E117):

| Tab | What it shows |
|---|---|
| **Visits** | Every request of the client core, newest first — visits, reloads, partial reloads (`only`/`except`), background visits (polls, `WhenVisible`, a live hint's reload), deferred props, prefetches, Back/Forward to a page memory let go of, layers, islands, actions, live validations, uploads — and the **live hints** that came: kind, status (`409 reload` for the protocol's full loads), time, the view it answered with, validation errors, optimistic patches; **server** shows what the server recorded for it |
| **Page** | The page on screen and each layer: component (**open in editor**), route, pattern, controller (**open in editor**), the answer that showed it, the query raw and parsed (with its defaults), and every prop with its size and badges: `deferred`, `streamed`, `optional` (left out — not sent), `merged`, `once`, `live`, `shared` |
| **Layers & regions** | The stack — the page, then each layer (key, `once`) — and the islands of each with their status (`loading`, `ready`, `unauthorized`, `forbidden`, `exception`) |
| **Optimistic** | Each optimistic patch (E59): the action or form it went with, the props it changed — before and as shown — and how it ended (`committed`, replaced by the server's props, rolled back) |
| **Server** | What the server recorded for a request (E131, by its `x-request-id`): route, controller, status, time, server rendering, queries, log, events, jobs — in the worker too — mails, notifications, live hints, exceptions; a link to its page here |
| **SSR** | The document's server rendering, and every hydration error React recovered from (a mismatch, or a part that failed on the server) |

**Only in development, never in a build (E115).** The provider adds two tags to the head of every document the **Vite dev
server** renders ([`DevDocument`](../server/README.md#the-development-document-devdocument--development-only) of
`@bespokecore/server`, bound with `NODE_ENV=development` only): `<meta name="bespoke-devtools">`
with the document's request id, and `<script type="module" src="/@id/@bespokecore/devtools/client">` — served by Vite from this
package's `./client` export; under the app's [`contentSecurityPolicy()`](../http/README.md#content-security-policy-e147) the
script carries the response's nonce (E147). Nothing of the app imports it, so no build has it; the production renderer never reads `DevDocument`.
In the head, it runs before the app's entry and sets the **dev hook** `__BESPOKE_DEVTOOLS_HOOK__`. The client core calls the hook
only under `process.env.NODE_ENV !== 'production'` — a production build drops every call, and the leak test checks that no chunk
names it:

- `Navigator` (made): the bar attaches its data feature — `devtools` of `@bespokecore/http/client` — and draws itself once that
  navigator takes over the history;
- `applyPatches`, the patch queue: which patches an action applied, what each changed, when it was folded in or taken out;
- the React adapter's `onRecoverableError` default: hydration errors.

**What it keeps (E36).** The data feature wraps the window's `fetch` and `EventSource` to see every request and hint; what it
records — and what the bar fetched from the API — lives **only in slots of the document**: when the document is left (a 409:
signed in or out, a new build) the core empties them and the panel shows nothing of it (`security-matrix.test.ts` holds it to that,
`client/bar.test.ts` checks its DOM). The panel reads the page's props from the navigator when it draws, never stores them;
`sessionStorage` holds `{ open, tab }` only. While a modal layer is open the bar moves into that dialog (everything outside a
modal dialog is inert).

### The protocol — for other tools

What the bar uses is documented, so a TanStack Devtools plugin, a Vite DevTools dock or a browser extension can be an adapter
later (E117): the JSON API and the stream above, and on the client:

| Part | Shape |
|---|---|
| Dev hook | `globalThis.__BESPOKE_DEVTOOLS_HOOK__: Partial<DevtoolsHook>` — `navigator(navigator)`, `patches(ids)`, `patched(id, beneath, changed)`, `committed(ids)`, `removed(ids)`, `recoverable(error, component, server)` (`DevtoolsHook` of `@bespokecore/http/client`); development builds only |
| Data feature | `navigator.use(devtools)` → `{ timeline, snapshots, hydration, cache, left, answerFor(url), subscribe(listener), onStarted(listener), stop(), record }` — the hook attaches it to every navigator made; the one that takes over the history (`start()`) is the app's, the others stop (React makes a new one when it renders the tree again after a hydration error) |
| Timeline entry | `{ id, kind, method, url, at, end?, status?, requestId?, answered?, outcome?, location?, reload?, only?, except?, name?, component?, errors?, patches?, channel?, hinted? }` — `kind`: `document`, `visit`, `reload`, `partial`, `background`, `deferred`, `prefetch`, `restore`, `layer`, `island`, `action`, `validation`, `upload`, `live`; `outcome`: `ok`, `invalid`, `reload` (409), `redirect`, `failed`, `cancelled`, `prefetched` |
| Request id | `x-request-id` of every answer; the document's in `<meta name="bespoke-devtools" content="…">` — `GET /_bespoke/devtools/api/requests/:requestId` (E131) |
| Visit events | `navigator.on('start' \| 'success' \| 'error' \| 'exception' \| 'cancel' \| 'finish' \| 'flash' \| 'version')` and the hook API `navigator.use(hooks).on('before' \| 'invalid')` (E132, [features](../http/README.md#features)) |

## Tests

With [@bespokecore/testing](../testing/README.md), a test opts in (`devtools: true`); `app.devtools` reads what was recorded:

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

The `EventDispatcher` publishes every dispatch on `bespoke:event` (`channels.subscribe(app, 'event', …)`,
[the channels](../core/README.md#the-channels)) — before a test's
`EventFake` decides whether listeners run. The fake keeps its one observer slot; the channel is for everyone else, built only
while something listens.
