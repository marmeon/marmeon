# @marmeon/core

The application kernel: the service container with constructor injection (generated `static inject` lists, no
decorators), service providers, modules, configuration, events, the clock, the request/job context and the ambient
transaction context — plus the diagnostics channels, health checks, redaction and error solutions every other package uses.
Every Marmeon package builds on it; an app depends on it directly (`defineApplication`, `defineModule`, `defineConfig`).
It has no provider of its own and is not discovered — it is what discovery runs on.

| Import | What |
| --- | --- |
| `@marmeon/core` | everything below |
| `@marmeon/core/environment` | `environment` and `resolveEnvironment` alone, without dependencies — what `marmeon` loads before anything else ([The environment](#the-environment-node_env)) |
| `@marmeon/core/register` | the Node loader hook that writes the injection lists of app code (`node --import`; `marmeon` loads it itself) — in a protected environment from `marmeon build`'s lists ([Precomputed lists](#precomputed-lists-in-production-e138)) |
| `@marmeon/core/vite` | the same transform as a Vite plugin (`marmeonInjection()` — part of `marmeon()` in [@marmeon/vite](../vite/README.md)) and `CSP_NONCE_PLACEHOLDER` |
| `@marmeon/core/diagnostics` | the observation channels ([Diagnostics](#diagnostics-marmeoncorediagnostics-e118)) |

## The application: `defineApplication`

`bootstrap/app.ts` describes the app and exports it — it boots nothing. `marmeon` boots it for a command or the server
([marmeon](../cli/README.md)); tests boot a fresh instance per test (`createTestApp(app)`,
[@marmeon/testing](../testing/README.md)).

```ts
// bootstrap/app.ts (apps/web-app)
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig, SystemDatabase, AppStorage],
  modules: [auth, userProfile, dashboard, members, notifications, locale, lab, system],
  middleware: { global: [SecurityHeaders, contentSecurityPolicy({ frameAncestors: ["'none'"] })], web: [ShareAppProps] },
});
```

| Option | What |
| --- | --- |
| `root` | the app root: `package.json`, `.env`, `.marmeon/`, `index.html` |
| `modules` | the feature modules, in the order they register and boot |
| `config` | app-level configuration (`defineConfig`) — validated with every other definition before anything registers |
| `providers` | app-level service providers (booted after the packages', before the modules') |
| `listeners` | app-level event listeners (`listen(Event, Listener)`) |
| `health` | app-level readiness checks for `/up/ready` ([Health checks](#health-checks-e126)) |
| `env` | the environment to validate against (default: `.env`, `.env.{NODE_ENV}`, then the real one — [Configuration](#configuration)) |
| `discover` | register the providers of installed packages (default `true`, [Discovery](#discovery-the-marmeon-field-and-marmeon-discover)) |
| `phase` | `'run'` (the default) or `'build'` — registered, never booted ([the build phase](#modules-definemodule), `ApplicationPhase`) |
| `override` | runs after every provider registered and before any boots — replace bindings there (tests) |
| `container` | a container to use instead of a new one |

Packages add their own options by declaration merging: `middleware` and `clientRoutes` come from
@marmeon/http ([Configuration](../router/README.md#configuration) of the router).

`createApplication(options)` creates and boots it and returns the `Application` (`root`, `container`, `modules`, `packages`
— the discovered ones —, `options`). In order: discovery, configuration (validated and bound), the core's bindings
(`Logger`, `Clock`, `Redactor`, `ErrorSolutions`, `HealthChecks`, `EventDispatcher`), every provider's `register()`,
`override`, every provider's `boot()` — then the warnings of the boot, each once per process (a `.env.{NODE_ENV}` that sets
`NODE_ENV`, a read-only `.marmeon/`, stale build artifacts; the packages' own, like the log mailer in production). A worker of
`marmeon start --workers=N` keeps its boot's warnings to itself: the primary booted the same app and said them once
(`CLUSTER_WORKER`, set by the primary; warnings after the boot are the worker's as always). `app.shutdown()` — also `await using app = …` — runs every provider's `shutdown()`
in reverse order, once; each gets its turn even if an earlier one fails (the errors are thrown together).

## Modules: `defineModule`

A feature module is a folder under `modules/` whose `index.ts` exports its definition — its name, providers, configuration,
listeners and health checks; every other package adds what a module contributes:

```ts
// modules/user-profile/index.ts (apps/web-app)
export default defineModule({
  name: 'user-profile',
  providers: [UserProfileServiceProvider],
  config: [ProfileConfig],
  listeners: [listen(Login, RecordLastLogin), listen(Registered, RefreshMemberStats)],
  jobs: [RebuildMemberStatsJob],                          // @marmeon/queue
  migrations: new URL('./migrations/', import.meta.url),  // @marmeon/database
  seeders: [DemoLinksSeeder],                             // @marmeon/database
  routes,                                                 // @marmeon/http: the `web` group
  apiRoutes,                                              // @marmeon/http: the `api` group, under /api
  schedule,                                               // @marmeon/scheduler
});
```

| Key | From |
| --- | --- |
| `name`, `providers`, `config`, `listeners`, `health` | core |
| `routes`, `apiRoutes` | @marmeon/http ([Registration](../router/README.md#registration) of the router) |
| `commands` | [marmeon](../cli/README.md#commands) |
| `migrations`, `seeders`, `exposes` | [@marmeon/database](../database/README.md) |
| `jobs` | [@marmeon/queue](../queue/README.md) |
| `notifications`, `recipients` | [@marmeon/notifications](../notifications/README.md) |
| `schedule` | [@marmeon/scheduler](../scheduler/README.md) |
| `csrfExcept` | [@marmeon/session](../session/README.md) |

Its `index.ts` is also its public API: other modules import from `#modules/user-profile` (the app's `package.json` maps
`"#modules/*": "./modules/*/index.ts"`) — `marmeon make:lint-config --boundaries` can enforce that
([Lint](../cli/README.md#lint)). `marmeon make:module <name>` writes a new one.

**The build phase (E187).** `createApplication({ ...definition, phase: 'build' })` is the app as `marmeon build` needs it — for
the route types (`route:types` runs so: `static boots = 'build'`): discovery, configuration, every provider's `register()` and
`override` — and **no** `boot()` (no connection, no driver check, no `shutdown()` afterwards; `app.phase` says `'build'`). A
configuration that does not validate — without `.env` that is `APP_KEY`, `APP_NAME`, database passwords, mail credentials … —
is left out instead of failing the start: reading it throws a `ConfigError` that names the variables and says the build has no
runtime secrets. So a build needs no `.env` and no key, and none can end up in what it writes. Named routes therefore belong
where `register()` sees them: a module's `routes` (the http provider loads them while registering) or a provider's own
`register()` — routes loaded in `boot()` serve requests but are not in `bootstrap/routes.ts`.

## Service providers

A provider registers and boots the services of a package or a module — Laravel's ServiceProvider. Any class with at least
one of the hooks or static lists:

```ts
export class UserProfileServiceProvider implements ServiceProvider {
  register(container: Container): void {          // bind only — other providers may not have registered yet
    container.singleton(LoginActivityRepository);
    container.singleton(MemberStats);
  }
  async boot(app: Application): Promise<void> { … }      // every provider has registered: resolve freely
  async shutdown(app: Application): Promise<void> { … }  // release pools, handles, subscriptions
}
```

| Static | What |
| --- | --- |
| `static config = [LogConfig]` | configuration the provider needs — validated with the app's own, before any provider registers |
| `static solutions = defineSolutions([…])` | solutions for its errors on the development error page ([Solutions](#solutions-e130)) |
| `static health = [DatabaseHealthCheck]` | readiness checks for `/up/ready` ([Health checks](#health-checks-e126)) |

Order: the providers of installed packages (dependencies first, from discovery), then `providers` of the app, then each
module's, in module order. **Every** provider registers before **any** boots; `shutdown` runs in reverse. A class listed as a
provider without any hook or list fails the start.

## Discovery: the `"marmeon"` field and `marmeon discover`

Packages register themselves: a package that opts in with a `"marmeon"` field in its `package.json` has its providers
registered by every app that installs it — no list in the app:

```json
{
  "name": "@marmeon/http",
  "marmeon": {
    "providers": ["HttpServiceProvider"],
    "browser": ["src/client/**", "src/page.ts"]
  }
}
```

- **`providers`:** exported from the package's entry, registered in dependency order (a package after the ones it depends on).
- **`browser`:** browser-only sources (globs relative to the package) — the injection transform leaves them alone, so no
  injection code reaches a client bundle (E76).
- **`marmeon discover`** walks the app's dependencies — its dev dependencies too, which a production install simply lacks — and
  writes `.marmeon/manifest.json`: the providers and the injection lists of the packages' exported classes, read from their
  `.d.ts` files (a package built with `marmeon package:build` carries its lists already). It runs **by itself** whenever
  `package.json`, the lockfile or the resolution conditions change — `pnpm add` needs no extra step — and again when a listed
  package is gone (a production install without the dev dependencies). The manifest is data, never imported: rewriting it
  restarts no dev server.
- **One manifest per set of resolution conditions (E160):** `.marmeon/manifest.json` for the published packages (an installed
  app, production) and `.marmeon/manifest.source.json` inside the framework's monorepo (`@marmeon/source`) — switching
  between `marmeon dev` and `marmeon start` there rewrites neither. Module paths are relative to the app, so a manifest written
  in a Docker build stage works where the app is copied to. Any other set gets its own file (Vitest adds `development`:
  `manifest.development+source.json`). `marmeon build` writes the production manifest.
- **Published packages run their `dist/`:** Node does not strip types under `node_modules`. A package that reaches Node with its
  TypeScript sources — packed with `npm pack` (which ignores `publishConfig.exports`), a workspace package copied with its
  workspace manifest, the `@marmeon/source` condition outside the framework's monorepo — fails the start with Node's
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; `marmeon` names the code and the solution (install the package as it is
  published). `marmeon` itself, copied under `node_modules` by `pnpm deploy`, runs its `dist/`.
- **Read-only `.marmeon/`:** when the manifest is out of date and cannot be written (`EACCES`, `EPERM`, `EROFS`), the app discovers in
  memory and logs one warning — it starts, never fails with `EACCES`. Run `marmeon build` (or `marmeon discover`) where it can
  write, e.g. in the image's build stage.
- `defineApplication({ discover: false })` registers nothing of the installed packages (`providers` then lists them by hand).

## The environment: `NODE_ENV`

One place decides what `NODE_ENV` means (E115, E139) — `environment` from `@marmeon/core` — and the two rules are not
mirror images:

| | `development` | `test` | `production`, `staging`, anything else, **none** |
| --- | --- | --- | --- |
| `environment.isDevelopment()` — development tools (Vite's dev server, error page details, devtools, `Server-Timing`, mail previews, pretty logs, regenerated table types) | yes | no | no |
| `environment.isProtected()` — protections (JSON logs, `migrate` needs `--force`, boot warnings, no lab pages, read-only writes dropped instead of thrown) | no | no | **yes** |

Protections are **fail-closed**: a staging box, a typo and a server without `NODE_ENV` are protected like production. Check
`isProtected()` on the protecting side and `isDevelopment()` for a development tool — never `=== 'production'` or
`!== 'production'`. Both read `process.env` unless given the `env` a config definition resolves from:

```ts
export const LabConfig = defineConfig('lab', {
  env: v.object({ NODE_ENV: v.optional(v.string()), LAB_PAGES: v.optional(v.picklist(['true', 'false'])) }),
  resolve: (env) => ({ enabled: env.LAB_PAGES === undefined ? environment.isDevelopment(env) : env.LAB_PAGES === 'true' }),
});
```

`environment.isTest()`, `environment.name()` (`undefined` when unset or empty) and `environment.fromDotEnv()` complete it.
`environment.describe()` names it the way start lines do: `production (protected)`, `staging (protected)`, `development`,
`test`, `unset NODE_ENV (protected, like production)`.

**Where it comes from (E170)** — one resolution, `resolveEnvironment(root)`, done by `marmeon` before anything of the app loads
(and by `createApplication` for a script that boots the app itself; an app given its own `env` decides for itself):

1. the process's `NODE_ENV` — the supervisor, the Dockerfile, the shell. It always wins;
2. else the app's **`.env`** — only the base file: `.env.{NODE_ENV}` is chosen by `NODE_ENV` and cannot set it (a `NODE_ENV` there
   is ignored, with a warning). `.env.example` carries `NODE_ENV=development`, so on a development machine every command
   (`migrate`, `tinker`, `queue:work`) is development;
3. else none — protected like production; `marmeon start` then sets `production`, `marmeon dev` `development` (the `fallback`
   option).

The result is written to `process.env.NODE_ENV` (the one exception to "`process.env` is never modified"), so config definitions,
the CLI, the load hook and the server all read the same value. A value from `.env` is named as such — `development (from .env)`,
`staging (protected, from .env)` — in start lines and `Environment:` lines. **The risk** is a developer's `.env` copied to a server:
then `marmeon start`, `queue:work` and `schedule:work` run as development, and each logs a loud warning (`NODE_ENV=development comes
from .env, not from the environment: …`) — they are not refused. On a server, set `NODE_ENV` in the environment and never deploy a
development `.env`. `createTestApp` runs as `test` unless its `env` says otherwise.

## Configuration

Packages, modules and the app declare their environment as config definitions (`defineConfig(name, { env, resolve })`,
validated with any Standard Schema). The app validates **all** of them before anything registers: a missing or invalid
variable stops the start with one `ConfigError` that lists every problem (`• encryption: APP_KEY — Missing — run "marmeon
key:generate"`). Variables come from `.env`, then `.env.{NODE_ENV}` (`.env.test`) on top, then the real environment, which
wins. `marmeon` prints how to fix it below the error (the solutions, E130).

```ts
// config/app.ts (apps/web-app)
import { defineConfig, type ConfigOf } from '@marmeon/core';
import * as v from 'valibot';

export const AppConfig = defineConfig('app', {
  env: v.object({
    APP_NAME: v.pipe(v.string(), v.nonEmpty()),
    APP_URL: v.pipe(v.string(), v.url()),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;

class ShowLoginController {
  constructor(config: AppConfig, session: Session) { … }   // a definition is also a token: injected like any service
}
```

- **Where it is listed:** `defineApplication({ config })`, `defineModule({ config })` or a provider's `static config` — each
  definition once, however often it is listed.
- **`resolve`** gets the schema's output and returns the typed value; `ConfigOf<typeof X>` is its type. Defaults belong in
  the schema (`v.optional(…, '3000')`); every value is a string until the schema transforms it.
- **`process.env` is never modified** (except the resolved `NODE_ENV`, [The environment](#the-environment-node_env)): the files
  are parsed with `util.parseEnv`; tests pass `createTestApp(app, { env })`.
- Each package's README lists its variables (`PORT` → [@marmeon/server](../server/README.md#configuration), `LOG_LEVEL` →
  [@marmeon/log](../log/README.md#configuration), …); `.env.example` of `apps/web-app` shows them together.

## The container

```ts
container.singleton(MemberStats);                        // one instance, built in the root container
container.singleton(Mailer, (c) => new TransportMailer(…)); // an interface's token → a factory (or a class)
container.scoped(SharedData);                            // one per scope — per request, job attempt or command
container.bind(EventDispatcher, (resolver) => new EventDispatcher(registry, resolver)); // a new one on every resolution
container.instance(Clock, new TestClock());              // a prebuilt value
container.make(MemberStats);                             // resolve (an unbound class is built — autowired)
container.has(Mailer);                                   // bound here or in a parent?
```

- **Scopes:** the kernel resolves controllers and middleware from `container.createScope()` per request; the worker per job
  attempt; `marmeon` per command. A scoped service resolved outside a scope — or by a singleton — is an error
  ([The container's errors](#the-containers-errors)): a singleton is built in the root and must never capture a request.
- **Tokens:** an interface has no runtime value, so it is bound and injected through a token of the same name —
  `export interface Mailer { … }` plus `export const Mailer = token<Mailer>('Mailer')`; one import gives both. The core's
  contracts are tokens: `Logger` (a console fallback until [@marmeon/log](../log/README.md) binds pino; its optional
  `enabled?(level)` says whether an entry at that level would go anywhere — written, or seen on the `log` channel —, asked
  before building a costly one: the request line with `LOG_LEVEL=silent`; a logger without it counts as enabled), `Clock`,
  `Translator` (bound per request by [@marmeon/i18n](../i18n/README.md#on-the-server-translator)).
- **Re-binding** replaces a cached singleton — `override` (tests) sees every binding before anything is built.
- `container.keys()` lists what is bound, for tooling ([tinker](../cli/README.md#tinker)).

## Constructor injection

App code gets its `static inject` lists from the injection transform (the loader of `marmeon dev`/`start`, the `marmeon()`
Vite plugin for Vitest and SSR); packages get them from `marmeon package:build`. A parameter is injectable when its type is a
class or a token that exists at runtime (a value import — not `import type` — or a declaration in the module). Interfaces are
injected through a token of the same name: `export const Mailer = token<Mailer>('Mailer')`. A class that declares its own
`static inject` is left alone.

**Defaulted and optional parameters end the list** — JavaScript's default applies. When such a parameter has an injectable
type (`clock: Clock = new SystemClock()`), the container would never inject it: a provider's or a test's binding never
reaches the class. The transform marks the class, and the container reports it **once per class when it first builds it**
(E128) — a warning, never an error:

```text
[warn] Injection: PruneTokensJob (modules/auth/jobs/PruneTokensJob.ts:5): the parameter "clock: Clock = new SystemClock()" is
defaulted, so the container never injects Clock — its default is always used, also when a provider or a test binds another
Clock. Remove the default to have it injected, or write `static inject = [...]` to make the choice explicit.
```

The log line is written in development (`NODE_ENV=development`); `container.warnings` keeps them for the development error
page, and `container.onWarning(listener)` hears them. A tree's `parent?: Self` is no dependency and gets no warning.

### Precomputed lists in production (E138)

The transform parses every app module with a constructor (oxc-parser) — at each start, unless `marmeon build` did it before:
the build writes `.marmeon/injections.json`, per module of the app the insertions the hook would make (the same analysis,
`analyzeInjections` + `insertionsOf`, line for line) and the SHA-256 of the source they were derived from. In a protected
environment (production, staging, no `NODE_ENV` — [The environment](#the-environment-node_env)) the hook applies them to every
module whose source is unchanged; oxc-parser is not loaded at all (it is imported on the first parse only — also by
discovery's declaration reader, which an up-to-date manifest never needs). The app stays `.ts`
(no compiled copy, no second code path); the file holds no paths of the build machine (messages name a module relative to the
app).

Nothing is trusted blindly: a module that changed since the build, or that the file does not know, is analysed as in
development, and the app logs once, after booting:

```text
[warn] Build artifacts are stale (1 file: modules/users/ShowUserController.ts): they changed since marmeon build, so their
injection lists were derived at start, with oxc-parser — run marmeon build again.
```

Without the file the message says `Build artifacts are missing (.marmeon/injections.json): …`. In development and in tests the
hook always analyses (the file may be old there). `computeInjectionArtifacts(root)` returns what `writeInjectionArtifacts({ root })`
writes; `PrecomputedInjections` is the hook's side.

## The container's errors

A `ContainerError` says why (`reason`), what (`key`) and who asked (`path`, `neededBy`):

| `reason` | Means | The fix |
|---|---|---|
| `unbound` | An interface's token has no binding. | Bind it in a provider's `register()` (`container.singleton(Mailer, …)`), or install the package that does (`marmeon discover`). |
| `scoped` | A per-request (scoped) service resolved outside a scope — or by a singleton, which would keep the first request's. | Resolve it from the request's scope (inject it into a controller, middleware, listener); a singleton that needs it becomes scoped too. |
| `no-injection-list` | A class with constructor parameters but no list — `injection` says what the transform could not inject (a number, a type-only import, a missing annotation). | Inject classes and tokens; primitives come from a config object. |
| `circular` | `A → B → A`. | Move what both need into a third class, or pass one of them per call. |

`container.keys()` lists every class and token bound in a container and its parents (the nearest binding first) — for
tooling: `marmeon tinker` completes them and resolves them by name. Resolving stays `make()`.

## Events and listeners

An event is a class — its class is its identity. A listener is a class with `handle(event)` (built through the container,
so it gets constructor injection) or a closure. Modules and the app list who listens to what:

```ts
// @marmeon/auth (its `static event` and `static schema` for queued listeners left out)
export class Registered {
  readonly #event = true;          // makes the class nominal: a listener for another event is a compile error
  readonly user: AuthUser;
  constructor(user: AuthUser) { this.user = user; }
}

// modules/user-profile/listeners/RecordLastLogin.ts
export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;
  constructor(activity: LoginActivityRepository) { this.#activity = activity; }
  async handle(event: Login): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
  }
}

defineModule({ name: 'user-profile', listeners: [listen(Login, RecordLastLogin), listen(Registered, RefreshMemberStats)] });
```

```ts
constructor(events: EventDispatcher) { this.#events = events; }
await this.#events.dispatch(new Registered(user));
```

- **In order, awaited:** listeners run one after the other in registration order — the event's class first, then the classes
  it extends. An error stops the dispatch and reaches the caller (in a request: the exception handler); the listeners after it
  do not run. For all or nothing, dispatch inside a transaction ([@marmeon/database](../database/README.md#transactions)):
  in-process listeners join it.
- **Per scope:** the `EventDispatcher` is resolved from the asking container — in a request, listeners are built from the
  request's scope and may use scoped services.
- **Queued listeners** (`static queue = { queue: 'mail' }` on the listener, E86) are queued as a job and run in a worker, with
  the event's payload (its `static event` and `static schema`) instead of the event object — they need
  [@marmeon/queue](../queue/README.md#transactions-e107-e109); without it the start fails. `listen()` checks the pairing at
  compile time.
- **Framework events** are classes like any other: `Login`, `Registered` (auth), the job events
  ([queue](../queue/README.md#job-events)), the scheduler's ([scheduler](../scheduler/README.md#events-e127)).
- Every dispatch is reported on the `event` channel ([Diagnostics](#diagnostics-marmeoncorediagnostics-e118)) — the
  devtools record it ([App events](../devtools/README.md#app-events-the-marmeonevent-channel)).

### Testing: `EventFake`

Every test app records the dispatched events (`app.events`, an `EventFake` — [Fakes](../testing/README.md#fakes)); faked events
are recorded and nothing else — their listeners neither run nor are queued:

```ts
const app = await createTestApp(application, { events: [Registered] });   // or 'fake' (all), or 'real' (the default)
await app.post('/register', { form }).assertRedirect();
app.events.assertDispatched(Registered, (event) => event.user.email === 'kj@example.com');
app.events.assertListening(Registered, RefreshMemberStats);
```

`assertDispatched(Class, match?)`, `assertDispatchedTimes(Class, n, match?)`, `assertNotDispatched`, `assertNothingDispatched`,
`assertListening(Class, listener)`, `dispatched(Class, match?)` — `match` is part of the event (`{ orderId: 'o-1' }`) or a test.

## The clock

Services that expire, schedule or wait take a `Clock` instead of calling `Date.now()` (E97):

```ts
constructor(clock: Clock) { this.#clock = clock; }
const expires = this.#clock.now() + 60_000;
```

`SystemClock` is the binding outside tests; every test app binds a `TestClock` ([Time](../testing/README.md#time)) —
`app.travel({ minutes: 5 })`, `app.travelTo(date)` and `app.freeze()` move it without fake timers. `Duration`
(`{ hours: 1, seconds: 30 }`) and `durationToMilliseconds()` are the core's spans of time. A `clock: Clock = new SystemClock()`
default is never injected ([Constructor injection](#constructor-injection)).

## Request, job and task context

The one deliberate piece of ambient state besides transactions (E3): which unit of work runs now — for cross-cutting concerns
like logging, never for services or data. The kernel sets the request (`runWithRequest`), the worker the job (`runWithJob`),
the scheduler the task (`runWithTask`):

```ts
currentRequest();      // { requestId } — the request's x-request-id
currentJob();          // { job, jobId, attempt, requestId? } — requestId: the request that dispatched it (E131)
currentTask();         // { task }
currentLogContext();   // what every log entry written now carries: { requestId }, { job, jobId, attempt }, { task }
```

`LogContextSources` (one per app) adds fields to every entry — `@marmeon/otel` adds the span's ids.

## The transaction context

Which database transaction the current async call chain runs in (E107). The transaction is
[@marmeon/database](../database/README.md#transactions)'s — `connections.transaction(callback)`, `repository.transaction(callback)`
—; the context and the functions around it live here, so every package can use them without depending on the database (the
database package re-exports them):

| Function | What |
| --- | --- |
| `afterCommit(fn)` | runs `fn` once the outermost transaction committed, outside of any transaction; never on a rollback; at once outside one |
| `afterRollback(fn)` | runs `fn` if the current transaction rolls back — undo work done outside it (a lock on the cache's connection) |
| `outsideTransaction(fn)` | runs `fn` outside the current transaction: its writes stay even when the transaction rolls back |
| `inTransaction()`, `currentTransaction()` | whether — and in which — transaction the call chain runs |

```ts
await connections.transaction(async () => {
  const user = await users.insert({ … });
  await afterCommit(() => mailer.send(new WelcomeMail(user)));
});
```

- **Entered only explicitly** and only for as long as its callback; everything awaited inside joins it. It never reaches
  another request, job or test running at the same time.
- **Loud, never silent:** work started inside a transaction that runs after it finished (an un-awaited promise, a timer)
  throws `TransactionFinishedError` instead of writing outside it.
- **Framework boundaries cut it:** work after the response, jobs and the worker never run inside the transaction that was open
  when they were registered.
- The rules, nesting (savepoints) and the limits: [Transactions](../database/README.md#transactions).

## Diagnostics: `@marmeon/core/diagnostics` (E118)

The framework reports what it does on `node:diagnostics_channel` **TracingChannels** — the channel kind the Node ecosystem
(undici, fastify, node-redis, …) uses. The error page, the devtools recorder, the debug bar, `Server-Timing` and
`@marmeon/otel` subscribe to them; apps keep using events (job events, scheduler events) for their own reactions.

```ts
import { channels } from '@marmeon/core/diagnostics';

// in a provider's boot(app):
this.#off = channels.subscribe(app, 'db.query', {
  start: (query) => { … },                                    // before (db.query: once it ended — Kysely reports afterwards)
  end: (query) => console.log(query.sql, query.durationMs, query.requestId ?? query.jobId),   // after, ok or failed
  error: (query) => { … },                                    // failed (before end), with query.error
});
channels.subscribe(app, 'log', (entry) => { … });             // a plain channel: one handler
// in its shutdown(): this.#off();
```

- **Nothing is built without a subscriber:** every place that publishes asks `hasSubscribers` first. `channels.built(app)`
  counts the messages built for an app (0 while nobody listens — the tests prove it).
- **Every message names its app** (`message.app`): `channels.subscribe(app, …)` passes on only that app's messages — two
  apps in one process (parallel tests, a worker beside a server) never see each other's. A subscription is the
  subscriber's: `off()` ends it, a provider calls it in `shutdown()`. The channels themselves are Node's, process-wide —
  the only shared part.
- **Raw values:** queries carry their parameters, log entries their context, exceptions the error. Whatever records or
  shows them redacts first (E125); `db.query`'s `secret` says when a statement touches secret columns.
- **A subscriber that throws** is reported as a process warning (`MarmeonDiagnosticsWarning`); the operation goes on. A
  `log` subscriber must not log itself.
- **Types:** `ChannelMessage<'db.query'>` is `DbQueryMessage`, and so on; a wrong field or channel name is a compile
  error (`Property 'route' does not exist on type 'DbQueryMessage'.`, `Argument of type '"db.querry"' is not assignable
  to parameter of type 'ChannelName'.`).

### The channels

Node names the traced ones `tracing:marmeon:<name>:{start,end,asyncStart,asyncEnd,error}`; the plain ones `marmeon:<name>`.

| Channel | Where | Message (besides `app`, `startedAt`, `requestId?`, `jobId?`, `task?`, `durationMs`, `error`) |
|---|---|---|
| `http.request` | the kernel, per request (also an island or a layer's base resolved in-process; never `/up`, E126) | `HttpRequestMessage`: `method`, `path`, `url` and `headers` (raw), `region`, `inProcess`, `route` (name), `routePath` (pattern), `controller`, `status`, `location` (raw: a redirect's target, or with a 409 the protocol's `x-marmeon-location`) and `reload` (its reason); while something listens also `page` (`PageSummary`: view, kind, the bytes of each prop, `only`/`except`, deferred groups) and `input` (the body as the app read it — raw; never read for this) |
| `db.query` | every statement of every connection | `DbQueryMessage`: `connection`, `driver` (`sqlite`/`pgsql`), `sql`, `parameters` (raw), `secret` |
| `queue.dispatch` | `queue.dispatch()`, `bulk()`, `chain()` | `QueueDispatchMessage`: `kind`, `jobs`, `jobIds`, `connection`, `queue`, `delay`, `unique`, `traceparent` (a tracer sets it), `payloads` (raw) and `encrypted` (per job) |
| `queue.job` | each attempt (worker, `sync`, `app.queue.work()`) | `QueueJobMessage`: `job`, `jobId`, `queue`, `connection`, `attempt`, `originRequestId`, `traceparent`, `payload` (raw), `encrypted`, `outcome` |
| `schedule.task` | each run of a scheduled task | `ScheduleTaskMessage`: `task`, `minute`, `reason`, `outcome`, `skipped` |
| `mail.send` | `mailer.send()`, `mailer.queue()`, the worker sending a queued mail (also the `MailFake` of tests) | `MailSendMessage`: `mailable`, `mode` (`send`/`queue`/`worker`), `to`, `subject`, `from`, `cc`, `bcc`, `html`, `text` (raw), `attachments` (name, bytes) |
| `notification.send` | `notifications.send()` (queued), each delivery (also the `NotificationFake`) | `NotificationSendMessage`: `notification`, `id`, `recipient`, `queued`, `channels`, `outcome` |
| `live.refresh` | a live hint going out (after its commit) | `LiveRefreshMessage`: `channel`, `only` |
| `render.ssr` | server rendering of a document, until its shell | `SsrRenderMessage`: `component`, `complete` (a crawler), `streamed` |
| `command.run` | one `marmeon <command>` in its own process (not a scheduled one) | `CommandRunMessage`: `command`, `args` (raw), `exitCode` |
| `log` *(plain)* | every log entry, any level (before the logger's level filter) | `LogMessage`: `level`, `message`, `context` (bindings + context) |
| `exception` *(plain)* | an error a request ends in, on its way to the `ExceptionHandler` | `ExceptionMessage`: `error`, `status`, `method`, `path` |
| `event` *(plain)* | every `EventDispatcher.dispatch()` — before a test's `EventFake` decides whether listeners run | `EventDispatchMessage`: `event` (raw), `name` (`static event` or class name), `listeners` |

- **Correlation (E131):** `requestId` is the request's `x-request-id` (the kernel answers with it); a job dispatched in a
  request keeps it as `originRequestId`. Queries, mails, notifications and log entries carry the `requestId` or `jobId` of
  where they happen.
- **Trace context:** `channels.around(app, name, (message, run) => …)` runs each traced operation's work inside a context
  of the subscriber's — `@marmeon/otel` runs it in the operation's span (`context.with(…, run)`), so what happens inside
  (its queries, the jobs it dispatches, its log lines, the app's own spans) is its child. Call `run` once, synchronously; a
  wrapper that throws or forgets it is a process warning and the work runs without it. (Node's `start.bindStore` cannot carry
  OpenTelemetry's context: Node 26 enters a bound store with `store.withScope()`, which only an `AsyncLocalStorage` has.)
  On `queue.dispatch` a tracer sets `message.traceparent` in `start` — the job stores it, its `queue.job` message carries it
  to the worker (also through the `QueueFake`). A raw subscriber (`channels.tracing(name)`) hears every app: compare
  `message.app` itself.
- **Log fields:** `LogContextSources` (one per app) adds fields to every log entry written now — `@marmeon/otel` adds
  the active span's `trace_id`, `span_id` and `trace_flags`; `@marmeon/log` and the fallback logger merge them.
- **Publishing (packages):** `messageBase(app)` (the common fields — counts as a message built), `trace(channel, message,
  fn, finish?)` (start → end → error → asyncStart → asyncEnd, `durationMs` set first) and `publishEnded(channel, message)`
  for an operation that already ended. Always behind `channel.hasSubscribers`.

### What `@marmeon/otel` makes of them (E120)

| Channel | Span (kind) | Attributes (semantic conventions; `marmeon.*` our own) |
|---|---|---|
| `http.request` | `GET /users/:user` (server; in-process: internal) — `{method}` without a route | `http.request.method`, `http.route`, `http.response.status_code`, `url.path` (sensitive route parameters `[redacted]`), `url.query` and `user_agent.original` (redacted), `url.scheme`, `server.address`/`port`, `marmeon.route.name`, `marmeon.controller`, `marmeon.request.id`; a 5xx: status error + `error.type` |
| `exception` | — (on the request's span, 5xx only) | an `exception` event, message and stack redacted; `error.type` = the error's class |
| `db.query` | `SELECT users` (client) — only inside another span | `db.system.name`, `db.query.text` (**no parameters**), `db.operation.name`, `db.collection.name`, `marmeon.db.connection` |
| `queue.dispatch` | `send <job>` (producer) | `messaging.system=marmeon`, `messaging.operation.type=send`, `messaging.destination.name`, `messaging.message.id`; its context → `traceparent` |
| `queue.job` | `process <job>` (consumer) — parent: the dispatch (`traceparent`) | `messaging.*`, `marmeon.job`, `marmeon.job.attempt`, `marmeon.job.outcome`, `marmeon.request.origin_id` |
| `schedule.task` | `schedule <task>` | `marmeon.schedule.task`, `.reason`, `.outcome`, `.skipped` |
| `mail.send` | `mail <Mailable>` (client) | `marmeon.mail.mailable`, `.mode`, `.recipients` (a count — no addresses, no subject) |
| `notification.send` | `notify <notification>` | `marmeon.notification`, `.queued`, `.recipient_type`, `.channels`, `.outcome` |
| `live.refresh` | `live refresh` (producer) | `marmeon.live.channel`, `.only` |
| `render.ssr` | `render <View>` | `marmeon.view`, `marmeon.ssr.complete`, `.streamed` |
| `log` | — | `trace_id`, `span_id`, `trace_flags` in the entry (`LogContextSources`) |

## Health checks (E126)

`/up/ready` ([@marmeon/server](../server/README.md#health-e126)) runs the app's `HealthChecks`: invokable classes with
`static check` (the name) and `handle()` (throws when the check fails; may return a short note), dependencies through the
constructor. Packages list theirs as `static health` on their provider (database: `select 1` on every connection; redis: `PING`
on each connection in use; cache: `add` + `forget`; queue: the default connection's size); the app adds its own with
`defineApplication({ health })` or `defineModule({ health })`. They run at once, each with a time limit (2 s, or
`static timeout` in ms); `run()` never throws.

```ts
export class StorageWritable implements HealthCheck {
  static check = 'storage';
  readonly #storage: Storage;
  constructor(storage: Storage) {
    this.#storage = storage;
  }
  async handle(): Promise<void> {
    await this.#storage.disk('local').put('.health', 'ok');
  }
}
defineModule({ name: 'system', health: [StorageWritable] });
```

A class without `static check` or `handle()` does not compile (`Property 'check' is missing in type 'typeof NoName' but required
in type '{ readonly check: string; readonly timeout?: number | undefined; }'.`); two classes with one name fail the start.

## Redaction (E125)

`Redactor` (one per app: `app.container.make(Redactor)`) is the one place that decides what of a value may be shown or
recorded — the development error page and its Markdown copy, the devtools recorder (`@marmeon/devtools`) and telemetry
spans. It is on by default, also locally:

- **by key**, at any depth: `REDACTED_KEYS` (passwords, tokens, secrets, cookies, `authorization`, signatures — so also
  `set-cookie`, `x-xsrf-token`, `_token`) and the names packages add — the session's cookie name (`addKeys`);
- **in text** (`redactText`): values of sensitive keys (`password=…`, `"token":"…"`, `?signature=…`), bearer credentials,
  URL passwords, password hashes (`$argon2id$…`, `$scrypt$…`), API tokens (`bc_12|…`, any prefix) and token-like path
  segments — 32 or more URL-safe characters, hex or mixed-case with digits (`/reset-password/<token>` in a mail's link, a log
  line or a `Referer`; slugs and UUIDs stay) —, plus the added names' values (`marmeon_session=…`);
- **statements** that touch a table with secret columns (`DbQueryMessage.secret`) show none of their parameters;
- **encrypted payloads** (a job with `static encrypted`, a queued mail or listener) only as `[encrypted]` (`payload(value, encrypted)`);
- **paths and URLs** by their route: the values of sensitive route parameters (`/reset/:token`) replaced (`path(path, pattern)`,
  `url(url, pattern)`);
- **files and bytes** only by their size; every string is cut at 64 KB, a recorded entry as a whole too (`fit(value)`).

```ts
const redactor = app.container.make(Redactor);
redactor.value({ email, password, avatar });   // { email, password: '[redacted]', avatar: '[file me.png, 5120 bytes, image/png]' }
redactor.headers(request.headers);             // cookie, authorization, x-xsrf-token → '[redacted]'
redactor.query(message);                       // { sql, parameters } — all '[redacted]' when message.secret
redactor.payload(payload, job.encrypted);      // '[encrypted]', or the payload redacted like a value
redactor.url(message.url, message.routePath);  // http://localhost/reset/[redacted]?email=…&token=[redacted]
redactor.fit(content);                         // at most 64 KB of JSON: long strings and lists shortened, else a preview
```

A safety net, not a guarantee: a secret quoted in free text under a harmless name still shows. Never put secrets into
messages.

## Solutions (E130)

The development error page shows **solutions** for errors it knows: a title, a text, a command to copy and a README anchor.
They are **text only** — no endpoint runs anything (Ignition's runnable solutions were CVE-2021-3129). A package lists its
solutions on its provider; an app can do the same:

```ts
import { defineSolutions } from '@marmeon/core';

export class PaymentsServiceProvider {
  static solutions = defineSolutions([
    {
      for: PaymentError,                                  // the class (and its subclasses)
      when: (e) => e.code === 'declined',                  // optional: narrows it — `e` is a PaymentError
      solve: (e, { app }) => ({ title: 'Use a test card', text: '…', command: 'marmeon payments:cards', docs: 'README.md#cards' }),
    },
  ]);
}
```

`solve` may look things up (the database's solution asks the migrator for pending migrations) and may return nothing.
`ErrorSolutions` (`app.container.make(ErrorSolutions)`) holds every provider's solutions, then the core's, and `find(error,
{ app })` looks through the error and its causes. The core brings solutions for the container's errors, the injection
transform, invalid configuration and a package that reaches Node with its TypeScript sources (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
[Discovery](#discovery-the-marmeon-field-and-marmeon-discover)); the packages add theirs (`http`: an undefined route name with "did you mean", a missing
view R2; `database`: a missing table and the pending migrations; `encryption`: a missing `APP_KEY`). `marmeon` prints them
too when the app cannot start, after the error and Node's code (`ERR_…`) when it has one.

## HTML: the escaping `html` template

```ts
import { html, raw } from '@marmeon/core';

html`<p>Hello ${user.name}</p><ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;   // every value escaped; nested html kept
```

For HTML the server writes itself — mails (`@marmeon/mail` re-exports it) and the devtools' pages. Values are escaped as
text and inside quoted attributes (`& < > " ' \``); `raw()` is markup you trust, never input. It does not judge URLs: put only
links you built into `href`.
