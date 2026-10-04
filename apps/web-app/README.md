# BespokeCore test app

The app every framework feature is shown and tested in (`modules/auth`, `modules/user-profile`).

```bash
cp .env.example .env && pnpm exec bespoke key:generate
pnpm exec bespoke migrate:fresh --seed
pnpm dev
```

## Demo users

`migrate:fresh --seed` creates three people. Each signs in with the password **`password`**:

| Name         | E-mail            |
| ------------ | ----------------- |
| Ada Lovelace | ada@example.com   |
| Alan Turing  | alan@example.com  |
| Grace Hopper | grace@example.com |

## Trying things out

`pnpm exec bespoke tinker` opens a REPL with the booted app (helpers: `.ls`); `--sandbox` rolls everything back at the end:

```bash
pnpm exec bespoke tinker --sandbox
> await repos.users.update(1, { name: 'Ada King' })
> await jobs.dispatch(SendWelcomeMailJob, { userId: 1 })   # a row in the sandbox's transaction — gone at the end
pnpm exec bespoke tinker --execute "await repos.users.count()"   # 3
```

## Health and traces

`/up` answers `OK` once the app runs, `/up/ready` checks the database, Redis (when in use), the cache, the queue and that the
private disk takes files (`modules/system/health/StorageWritable.ts`) — with each check's time and note under `bespoke dev`:

```bash
curl -s localhost:3960/up/ready   # {"status":"ok","checks":[{"name":"database","status":"ok","ms":0.4,"note":"default, system"},…]}
```

Traces go to any OpenTelemetry backend when the SDK is started first (`bootstrap/telemetry.ts`, packages/otel/README.md) — e.g.
a local Jaeger (`docker run -p 16686:16686 -p 4318:4318 jaegertracing/jaeger`):

```bash
OTEL_SERVICE_NAME=web-app NODE_OPTIONS='--import ./bootstrap/telemetry.ts' pnpm exec bespoke dev
```

`modules/system/telemetry.test.ts` shows what a registration records: `POST /register`, its queries without parameters, the
welcome job in the same trace, its mail, and the trace id in the log line.

## Devtools

Under `bespoke dev` (`NODE_ENV=development`) the devtools record what the server, the worker and the scheduler do — requests
with their queries, jobs, mails, log entries, exceptions, events — redacted, into `storage/framework/devtools/` (NDJSON,
50 MB / 24 h; `config/devtools.ts`, packages/devtools/README.md). `@bespokecore/devtools` is a dev dependency: production
records nothing (and does not have the package). `bespoke devtools:clear` empties the directory; `devtools:prune` runs hourly in
development (`modules/system/schedule.ts`).

Every page under `bespoke dev` shows the **in-page bar** — a pill at the bottom right, `Alt+Shift+D` (W7 step 9): the visits and
other requests as they happen, the page's props with their sizes and badges (deferred, optional, merged, once, live, shared,
streamed), layers and islands, optimistic patches, what the server recorded for a request (queries, jobs in the worker), and
hydration errors — `/lab/devtools?mismatch=1` makes one on purpose; `/lab/devtools` shows the client hook API (E132: a link
`before` cancels, a form whose errors `invalid` reports). "Open in editor" goes through Vite (`LAUNCH_EDITOR`). Served by the Vite dev server only:
no build has it.

**`http://localhost:3960/_bespoke/devtools`** shows everything recorded — the bar links there: requests with their queries, props' sizes and what they set
off in the worker, the queue (with failed jobs and `bespoke queue:retry <id>` to copy), the schedule with the lock warning
(E123: `CACHE_DRIVER=file` locks only on this machine), a live tail, and the mail previews (`/_bespoke/mail`). Signing in, up or
out as a visit answers `409 reload` — the protocol's full reload, shown as such, not as an error.

`modules/system/devtools.test.ts` shows what a registration records — the request, its queries (the insert into `users`
without parameters), the jobs it queued, and the mails the worker sent for it, all tied by the request id — and how the pages
show it.
