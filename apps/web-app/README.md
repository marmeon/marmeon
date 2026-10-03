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
