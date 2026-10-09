# Marmeon test app

The app every framework feature is shown and tested in (`modules/auth`, `modules/user-profile`, `modules/dashboard`,
`modules/members`, `modules/notifications`, `modules/locale`, `modules/lab`, `modules/system`). `/members` is a server-driven table
([@marmeon/table](../../docs/tables.md)): Ada (an administrator, `DASHBOARD_ADMINS`) sees the e-mail column, removes
profile links (one member or many) and downloads the list as CSV; Alan and Grace see the table without them.

```bash
cp .env.example .env && pnpm exec marmeon key:generate
# .env (from .env.example) says NODE_ENV=development — without it a command counts as production (E139) and asks for --force
pnpm exec marmeon migrate:fresh --seed
pnpm dev                     # http://localhost:3000 — Redis for live updates: docker compose up -d in the repository
```

## How it is secured

What the starter kit has, and a little more — each part tested here:

- **Private registration** (E146, the default of `make:auth` since E193 — `AUTH_PRIVATE_REGISTRATION`): a new address and a known one
  get the same answer in the same time; the owner of a known one gets a mail instead. Every page of the app's modules — dashboard, people, profiles,
  notifications, settings, tokens — sits behind `verified()`: an unconfirmed account reaches the notice, the link, resend and
  sign-out only. Its forms carry no `_token`: Fetch Metadata and `Origin` vouch for them (E143).
- **Sessions** in the `database` driver on a SQLite file of their own (`SESSION_CONNECTION=system`), under hashed keys and with
  `SESSION_ENCRYPT=true` (E144); the password change and "sign out other devices" run one at a time per session (`block()`,
  E145).
- **Headers:** `middleware/SecurityHeaders.ts` (`nosniff`, a referrer policy, `X-Frame-Options`, an HSTS switch) and
  `contentSecurityPolicy({ styleSrc: ["'self'", NONCE], frameAncestors: ["'none'"] })` — a nonce per document (E147), no inline
  style (E202, `pnpm csp:probe` counts 0 violations) — in `bootstrap/app.ts`.
- **Wave 10:** development routes answer 404 outside development and 403 to a foreign host (E200, `devOnly()`); `NODE_ENV` is
  asked positively (E201); accounts that never confirmed an address go after 7 days, with their avatar, data export and
  notifications (E203); the CSRF token is drawn on demand; validation never answers "taken" live (E197, E206); the lab
  (`/lab/validation`) shows the rules, `when`, an async check, `exists` and `failOnDuplicate()` after a race.
- **Tab sync** (E148): sign in, out or switch the language in one tab and the others follow; a tab with unsaved changes asks
  first, in the app's own `Confirm` (`layouts/Confirm.tsx`). Signing out clears the site's cache and storage, the language
  switch the cache only (`clear({ siteData: ['cache'] })`). `modules/auth/tab-sync.test.ts` drives two tabs against the app.

`pnpm bench login` and `pnpm bench people` (from the repository's root) measure this app's request path in-process — the
numbers are in [the contribution guide](../../CONTRIBUTING.md#benchmarks).

## Demo users

`migrate:fresh --seed` creates three people. Each signs in with the password **`password`**:

| Name         | E-mail            |
| ------------ | ----------------- |
| Ada Lovelace | ada@example.com   |
| Alan Turing  | alan@example.com  |
| Grace Hopper | grace@example.com |

## Trying things out

`pnpm exec marmeon tinker` opens a REPL with the booted app (helpers: `.ls`); `--sandbox` rolls everything back at the end:

```bash
pnpm exec marmeon tinker --sandbox
> await repos.users.update(1, { name: 'Ada King' })
> await jobs.dispatch(SendWelcomeMailJob, { userId: 1 })   # a row in the sandbox's transaction — gone at the end
pnpm exec marmeon tinker --execute "await repos.users.count()"   # 3
```

## Health and traces

`/up` answers `OK` once the app runs, `/up/ready` checks the database, Redis (when in use), the cache, the queue and that the
private disk takes files (`modules/system/health/StorageWritable.ts`) — with each check's time and note under `marmeon dev`:

```bash
curl -s localhost:3000/up/ready   # {"status":"ok","checks":[{"name":"database","status":"ok","ms":0.4,"note":"default, system"},…]}
```

Traces go to any OpenTelemetry backend when the SDK is started first (`bootstrap/telemetry.ts`, docs/observability.md) — e.g.
a local Jaeger (`docker run -p 16686:16686 -p 4318:4318 jaegertracing/jaeger`):

```bash
OTEL_SERVICE_NAME=web-app NODE_OPTIONS='--import ./bootstrap/telemetry.ts' pnpm exec marmeon dev
```

`modules/system/telemetry.test.ts` shows what a registration records: `POST /register`, its queries without parameters, the
welcome job in the same trace, its mail, and the trace id in the log line.

## Devtools

Under `marmeon dev` (`NODE_ENV=development`) the devtools record what the server, the worker and the scheduler do — requests
with their queries, jobs, mails, log entries, exceptions, events — redacted, into `storage/framework/devtools/` (NDJSON,
50 MB / 24 h; `config/devtools.ts`, docs/devtools.md). `@marmeon/devtools` is a dev dependency: production
records nothing (and does not have the package). `marmeon devtools:clear` empties the directory; `devtools:prune` runs hourly in
development (`modules/system/schedule.ts`).

Every page under `marmeon dev` shows the **in-page bar** — a pill at the bottom right, `Alt+Shift+D` (W7 step 9): the visits and
other requests as they happen, the page's props with their sizes and badges (deferred, optional, merged, once, live, shared,
streamed), layers and islands, optimistic patches, what the server recorded for a request (queries, jobs in the worker), and
hydration errors — `/lab/devtools?mismatch=1` makes one on purpose; `/lab/devtools` shows the client hook API (E132: a link
`before` cancels, a form whose errors `invalid` reports). "Open in editor" goes through Vite (`LAUNCH_EDITOR`). Served by the Vite dev server only:
no build has it.

**`http://localhost:3000/_marmeon/devtools`** shows everything recorded — the bar links there: requests with their queries, props' sizes and what they set
off in the worker, the queue (with failed jobs and `marmeon queue:retry <id>` to copy), the schedule with the lock warning
(E123: `CACHE_DRIVER=file` locks only on this machine), a live tail, and the mail previews (`/_marmeon/mail`). Signing in, up or
out as a visit answers `409 reload` — the protocol's full reload, shown as such, not as an error.

`modules/system/devtools.test.ts` shows what a registration records — the request, its queries (the insert into `users`
without parameters), the jobs it queued, and the mails the worker sent for it, all tied by the request id — and how the pages
show it.
