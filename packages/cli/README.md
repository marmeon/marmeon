# marmeon

The `marmeon` command: the launcher (`marmeon dev`, `marmeon start`), the built-in commands (`build`, `route:types`,
`route:list`, `discover`, `key:generate`, `make:*`, `tinker`) and the commands of the installed packages and the app's
modules. It is a **dependency** of the app, not a dev dependency (E159): `marmeon start`, `queue:work`, `schedule:work` and
`migrate` run on the server, and `pnpm install --prod` (a Docker image) leaves dev dependencies out. Its `CliServiceProvider` is found by `marmeon discover` like any package's and collects the modules' commands. Run
it in the app root — `marmeon list` (or plain `marmeon`) shows every command the app has.

## Commands

### `marmeon dev`

The development server: Vite's dev server with HMR and server rendering inside the app's HTTP server, restarted by
`node --watch` when server code changes. It sets `NODE_ENV=development` when neither the environment nor the app's `.env` sets
it (E170) — the switch for
everything that exists only in development (E115): the error page and `Server-Timing`
([@marmeon/server](../server/README.md#error-page-e119--development-only)), the [devtools](../devtools/README.md), the
[mail previews](../mail/README.md#previews-e106). Next to the server it starts what packages add to
`DevProcesses` — a queue worker on every queue (`queue:work`, unless the default connection is `sync`,
[@marmeon/queue](../queue/README.md)) and the scheduler (`schedule:work`, when the app schedules tasks,
[@marmeon/scheduler](../scheduler/README.md)) — stopped and restarted with it, and started again
when one ends on its own; a server that dies without stopping them (killed, crashed) closes their IPC channel, and they stop as on
SIGTERM — never left running beside the next one. It keeps `bootstrap/routes.ts` current: on every start, and when a view is added or removed. All of
this — Vite's dev server included — needs `NODE_ENV=development`: with another `NODE_ENV` set (`staging`, `test`), `marmeon dev`
says so and serves the build, without workers or watchers (never "anything but production", E115).

### `marmeon build` and `marmeon start`

```sh
marmeon build                  # injection lists, route:types, tsc --noEmit, the client build (dist/client), the SSR build (dist/server/ssr.js), .br/.gz of the assets, the manifest
marmeon build --no-typecheck   # without the type check
marmeon start                  # the server on the build — no Vite, no workers; NODE_ENV=production unless set (environment, then .env)
NODE_ENV=staging marmeon start # staging: protected like production (E139) — but React's development build: see below
marmeon start --workers=4      # four servers on one port (node:cluster, E140) — each drains on SIGTERM
SHUTDOWN_DELAY=5 marmeon start # SIGTERM: /up/ready 503 at once, 5 more seconds of requests, then the drain (E163)
```

`build` precomputes the app's injection lists (`.marmeon/injections.json`, [A fast start](#a-fast-start-e138)), runs
`marmeon route:types` (in the app's build phase, E187: providers registered, none booted, no `.env` or secret needed), type-checks the app against the
generated route types (a renamed route or a missing view fails the build) and builds with the app's own Vite config and the
`marmeon()` plugin ([@marmeon/vite](../vite/README.md)). A route name the browser's manifest cannot know and client code
that imports server code as a value fail it too, each with file and line
([Server code in the browser](../vite/README.md#server-code-in-the-browser-e121)). Then it compresses the client's assets once —
a `.br` and a `.gz` next to each file in `dist/client/assets`, which the server sends by `Accept-Encoding` (E162; it never
compresses per request). Last, `build` writes the production
discovery manifest (`.marmeon/manifest.json`, [Discovery](../core/README.md#discovery-the-marmeon-field-and-marmeon-discover)),
so the first `start` rewrites nothing and `.marmeon/` may be read-only on the server.

`start` respects a `NODE_ENV` that is set and sets `production` only when it is missing (E139) — set in the environment or,
failing that, in the app's `.env` (E170, [Where it comes from](../core/README.md#the-environment-node_env)). A `.env` that says
`development` makes `start`, `queue:work` and `schedule:work` development — with a loud warning in their log and
`development (from .env)` in the start line; on a server set `NODE_ENV` in the environment. Every `NODE_ENV` but
`development` and `test` is **protected** — JSON logs, `migrate` asks for `--force`, no lab pages, the boot warnings — and
Marmeon takes its production branches there; the development tools still need `NODE_ENV=development` (E115,
[@marmeon/core](../core/README.md#the-environment-node_env)). Staging is **not** production for React: it renders with its
development build and sends a late server error's message and stack into the page — keep staging private, or run it with
`NODE_ENV=production` ([deployment](../../docs/deployment.md#configuration)). The start line names it:
`Marmeon in staging (protected) on http://localhost:3000 (the build; 54 routes, …)`. Queue workers and the scheduler run as
processes of their own there (`marmeon queue:work`, `marmeon schedule:work`, under a supervisor); each names the environment it
assumed when it starts, and so do `migrate` and its siblings. `dev` and `start` stop gracefully on SIGINT/SIGTERM
([@marmeon/server](../server/README.md#startserver-and-the-drain)) — the handlers are in place before the server listens, so
a SIGTERM that comes while it starts still drains once it listens. **SIGTERM** (a deployment, `docker stop`, Kubernetes,
systemd) first waits `SHUTDOWN_DELAY` seconds with `/up/ready` at 503 (E163, default 0); **SIGINT** (Ctrl+C) skips the delay.

### Several processes: `--workers` (E140)

`marmeon start --workers=N` runs N servers in worker processes of `node:cluster`, sharing the port; the process you started is
the primary. It passes SIGTERM/SIGINT on to every worker — each drains like a single server (readiness, `SHUTDOWN_DELAY`, the
requests in flight, the work after the response) — and exits with 0 once all exited with 0, else with the first worker's code
(after 10 s plus the delay a worker that hangs is killed). A worker that ends while the cluster runs is started again after a
second; one that ends before it listened (a taken port, a missing build) stops the cluster with its code instead of failing
forever. The warnings of the boot (a log mailer in production, cookies without `Secure`, stale build artifacts, a development
`.env`) are said once, by the primary — the workers boot the same app and keep them to themselves; what a worker warns about
later is its own. With `PORT=0` the system picks the port and all workers share the one the start line names. Each worker has its own readiness, rate-limit memory and `memory` stores — use `redis` or `database` drivers for
sessions, cache and locks, and `LIVE_DRIVER=redis` for live hints (as with several containers). `LIVE_DRIVER=memory` with
`--workers` fails the start ([@marmeon/live](../live/README.md#configuration)): a hint would reach the streams of one worker
only. One process per container (more containers) is the default
model; `--workers` is for a machine with several cores and one service. `marmeon dev` refuses it.

### Production files: `make:docker` (E141)

```sh
marmeon make:docker                    # Dockerfile, .dockerignore, compose.production.yaml (web, worker, scheduler)
marmeon make:docker --caddy            # … with Caddy in front (TLS, HTTP/2 + 3) — deploy/Caddyfile
marmeon make:docker --nginx --systemd  # … nginx on the host (deploy/nginx.conf) and systemd units (deploy/systemd/*.service)
```

- **Dockerfile** — multi-stage on `node:26-slim`: the app's package manager (`pnpm` pinned from `packageManager`, else
  `pnpm@12.9.1`, installed with `npm i -g` — Node ships no Corepack; `npm ci` for an app with `package-lock.json`), a frozen
  install with a cache mount, `marmeon build` (no `.env`, no key — the build phase needs no secret, E187), a fresh production install, `marmeon discover`; the final stage has Node and the app only, the code owned by root and
  readable for everyone, `storage/` owned by `node`, `USER node`, `NODE_ENV=production`, `HOST=0.0.0.0`, a `HEALTHCHECK` with
  Node's `fetch` on `/up` (no curl in the image), `tini` as PID 1 (`ENTRYPOINT ["/usr/bin/tini", "--", "marmeon"]`, E187),
  `CMD ["start"]`. Local packages the lockfile points
  to (`file:./vendor/…`) are copied before the install.
- **`.dockerignore`** — every `.env*`, `node_modules`, `dist`, `.marmeon`,
  `storage`.
- **`compose.production.yaml`** — one image, a role per container: `web` (`start`), `worker` (`queue:work` — every queue, E199;
  a stuck job's exit 70 is restarted by `restart: unless-stopped`), `scheduler` (`schedule:work`); `env_file:
  .env.production`, a `storage` volume, the health check off for worker and scheduler, `stop_grace_period` longer than the drain.
- **Proxies** — `--caddy` adds a Caddy service (certificates, HTTP/2 and 3; live streams unbuffered) and `TRUSTED_PROXIES: '*'`
  for the unpublished web container; `--nginx` the same with nginx (`http2 on`; `X-Forwarded-For` set to `$remote_addr`,
  `-Proto` and `-Host` set too — replaced, never a client's passed on; `proxy_read_timeout` above the live heartbeat; an upstream
  that keeps 16 idle connections and closes them after 60 s, before the app's `KEEP_ALIVE_TIMEOUT` of 65 s —
  [Behind a proxy](../server/README.md#behind-a-proxy-e162)). Neither compresses documents (no `encode`, `gzip off`: BREACH);
  the assets arrive compressed. With `--systemd` the proxy is for the host, in front of `127.0.0.1:3000`; the web container then
  publishes its port on `127.0.0.1` only and trusts no proxy until you name its address.
- **systemd** — `deploy/systemd/{web,worker,scheduler}.service`: `Restart=always`, `KillSignal=SIGTERM`, `TimeoutStopSec=30`
  (longer than the drain or the worker's `--stop-timeout`), `ProtectSystem=strict` with `storage/` writable, the web server on
  `127.0.0.1` trusting the local proxy.

The files are the app's afterwards; an existing one is overwritten only with `--force`. The image of the blank app with
`make:auth` is about 320 MB (`node:26-slim` alone 271 MB; its production `node_modules` 97 MB) — `pnpm run ci` builds and runs it
(`image`). The whole story — roles, Kubernetes, proxies, mail, drivers with more than one instance, keys — is the
[deployment guide](../../docs/deployment.md).

### One process (E159)

`marmeon` runs a command in its own process: `marmeon start` **is** the server — PID 1 in a container — so a supervisor's SIGTERM,
a worker's exit code (70 for a job that ignored its timeout) and `NODE_OPTIONS='--import ./bootstrap/telemetry.ts'` reach exactly
one Node process. The injection hook is registered in that process (`module.registerHooks`) before the command loads. Node is
started a second time only for what a running process cannot switch on: `node --watch` for `marmeon dev`, and the
`@marmeon/source` condition when the CLI runs inside the framework's own monorepo — a `pnpm-workspace.yaml` above it lists its
directory among `packages` (E187; its packages resolve to their TypeScript sources there; a published package does not carry the
condition) — never for `marmeon start`, which serves the packages' `dist/` there too. A copy of the CLI (what `pnpm deploy` or an
injected workspace dependency leaves under `node_modules`, with the workspace manifest and its source condition) is no workspace
package: it runs its `dist/` like a published package — Node resolves the condition only when the launcher gives it. In an image,
`tini` is PID 1 in front of it (E187: signals passed on, orphans reaped).

When the app cannot start, `marmeon` prints the error with Node's code when it has one (`ERR_…`) and the solutions below it
([Solutions](../core/README.md#solutions-e130)) — e.g. for `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, a package that reaches
Node with its TypeScript sources instead of its `dist/`; exit code 1.

### A fast start (E138)

`marmeon build` precomputes the app's injection lists first (`.marmeon/injections.json`,
[@marmeon/core](../core/README.md#precomputed-lists-in-production-e138)) and writes the production discovery manifest last;
`marmeon start` applies the lists without loading oxc-parser and turns on Node's compile cache before anything loads —
`storage/framework/compile-cache`, or Node's own `NODE_COMPILE_CACHE`; `NODE_DISABLE_COMPILE_CACHE=1` turns it off. The cache
is written once the server listens. What it does with the injection hook, the numbers and what is deliberately not cached:
[Start in production](../server/README.md#start-in-production-e138-e161). The tinker REPL loads with `marmeon tinker` only.

### Built-in commands

| Command | What |
| --- | --- |
| `route:list` | every registered route: method, path, name, group, middleware, action |
| `route:types [--check]` | writes `bootstrap/routes.ts` (route names, parameters and views for the type checker) and `.marmeon/routes.json` (the routes the browser may learn); `--check` fails when it is out of date (CI) |
| `discover` | writes `.marmeon/manifest.json` (`manifest.source.json` in the monorepo) — the installed packages' providers and injection lists ([Discovery](../core/README.md#discovery-the-marmeon-field-and-marmeon-discover)); also runs by itself when dependencies change |
| `key:generate [--show] [--force]` | sets `APP_KEY` in `.env` (copied from `.env.example` when missing); `--show` prints a key only; an existing key needs `--force`, which moves it to the front of `APP_PREVIOUS_KEYS` (E169) — sessions, encrypted cookies and signed links stay valid ([Key rotation](../encryption/README.md#key-rotation)) |
| `tinker [--sandbox] [-e "<code>"] [--no-history]` | a REPL with the booted app ([tinker](#tinker)) |
| `make:lint-config [--boundaries] [--force]` | writes `.oxlintrc.json` ([Lint](#lint)) |
| `make:docker [--caddy\|--nginx] [--systemd] [--force]` | writes a Dockerfile, `.dockerignore`, `compose.production.yaml` and, on request, a proxy configuration and systemd units ([Production files](#production-files-makedocker-e141)) |
| `package:build [dirs…] [--clean]` | builds framework packages and embeds their injection lists (for publishing); `--clean` empties `dist/` and the build info first — `tsc -b` never deletes what a removed source left behind |

Generators write files into a module and say where to register them; they run without booting the app and never overwrite a
file without `--force`:

| Command | Writes |
| --- | --- |
| `make:module <name>` | `modules/<name>/index.ts` and `routes.ts` — then add it to `modules` in `bootstrap/app.ts` |
| `make:controller <Name> --module=<m> [--view] [--request]` | an invokable controller (`--view`: and its view; `--request`: with a query or body schema) |
| `make:event`, `make:job`, `make:notification`, `make:middleware` `<Name> --module=<m>`; `make:listener <Name> --event=<Event> --module=<m>` | the class in the module's folder of that kind |
| `make:migration <snake_case_name> --module=<m>` | a timestamped migration in `modules/<m>/migrations/` |

### Commands of the packages

| Package | Commands |
| --- | --- |
| [@marmeon/database](../database/README.md) | `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:fresh [--seed]`, `migrate:status`, `db:seed`, `db:show`, `db:types [--check]` |
| [@marmeon/queue](../queue/README.md) | `queue:work`, `queue:size`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`, `queue:prune-failed`, `make:queue-table` |
| [@marmeon/scheduler](../scheduler/README.md) | `schedule:work`, `schedule:run`, `schedule:list`, `schedule:test` |
| [@marmeon/cache](../cache/README.md) | `cache:clear`, `cache:prune`, `make:cache-table` |
| [@marmeon/session](../session/README.md) | `session:prune`, `make:session-table` |
| [@marmeon/storage](../storage/README.md) | `uploads:prune` (`--hours` below `UPLOADS_LIFETIME` needs `--force`), `make:uploads-table` |
| [@marmeon/notifications](../notifications/README.md) | `notifications:prune`, `make:notifications-table` |
| [@marmeon/auth](../auth/README.md) | `make:auth [--adapter=react] [--force]` ([private registration](../auth/README.md#private-registration-e146-e193) by default, E146/E193), `auth:prune-tokens`; the module of `make:auth` adds `auth:prune-unverified` (E203) |
| [@marmeon/devtools](../devtools/README.md) | `devtools:clear`, `devtools:prune` |

### Writing a command

A command is a class with `static command`, `static description` and `handle()` — built through the container in a scope of
its own (constructor injection, scoped services like a request's), the app shut down afterwards. A returned number is the
exit code:

```ts
// @marmeon/auth (shortened)
export class PruneTokensCommand {
  static command = 'auth:prune-tokens';
  static description = 'Delete expired password reset, remember-me and API tokens';
  static usage = '[--hours=0]';
  static options = { hours: { type: 'string' } } as const;   // node:util parseArgs — an unknown option is an error

  readonly #access: AccessTokenStore;
  constructor(access: AccessTokenStore) { this.#access = access; }

  async handle({ options, output }: CommandInput): Promise<number> {
    const access = await this.#access.prune(Number(options.hours ?? 0) * 3600);
    output.success(`Pruned ${access} API tokens.`);
    return 0;
  }
}
```

An app's module lists its commands in `defineModule({ commands: [...] })`; a package adds its own in its provider's `boot()`
(`app.container.make(CommandRegistry).add([PruneTokensCommand])`). `static usage` shows in errors and help,
`static boots = false` runs a command without booting the app (generators), `static boots = 'build'` with the app as `marmeon build`
has it (registered, not booted, no runtime secret — `route:types`, E187) — both read for the built-in commands only: an app's or
a package's commands are found by booting the app, so they always run in a booted one. `static hidden` keeps it out of `marmeon list`. The
scheduler runs commands as tasks (`s.command('auth:prune-tokens').daily()`), each in a scope of its own. Each run is reported on
the `command.run` channel ([Diagnostics](../core/README.md#diagnostics-marmeoncorediagnostics-e118)).

## tinker

A REPL with the booted application (E122) — Node's own (`await` at the top level, preview, multi-line input), with
TypeScript input and a few helpers:

```text
$ marmeon tinker
Marmeon tinker · web-app · NODE_ENV=development · db sqlite (storage/database.sqlite) · .ls lists helpers
> const user = await repos.users.find(1)
> const n: number = await repos.users.count()
> await jobs.dispatch(SendWelcomeMailJob, { userId: user!.id })
> url('user-profile.show', { user: 1 })
'/users/1'
> make(Mailer)                              // make(<Tab> completes class and token names
```

| Helper | What it is |
|---|---|
| `app` | the `Application` — container, modules, root |
| `make(Key)` · `make('Name')` | resolves a class or token in the session's scope (by name, too) |
| `db` | Kysely on the default connection (`@marmeon/database`) |
| `repos.<table>` | the app's repositories: every `*Repository.ts` under the app (not `node_modules`, `dist`, `storage`), by its `static table` — by class name where two share a table |
| `jobs` | the `Queue` (`@marmeon/queue`) |
| `events` | the `EventDispatcher` |
| `mail` | the `Mailer` (`@marmeon/mail`) |
| `url(name, params?, query?)` | the path of a named route |
| `t(key, params?)` | a text in `APP_LOCALE` (`@marmeon/i18n`) |
| `config.<name>` | the resolved configuration, by name (`config.app`, `config.mail`, …) |

- **By name:** every class and token the container binds, every class a module lists (jobs, notifications, seeders,
  listeners and their events, …) and every repository is there by its name — `make(Mailer)`, `jobs.dispatch(SendWelcomeMailJob, …)`
  need no import. A name the REPL already has (`URL`, `Response`) keeps its meaning.
- **Lazy:** a helper is built on first use; one the app has no package for says what to install (`.ls` marks it). Assigning
  to a helper (`db = …`) replaces it like any variable.
- **One scope per session**, like a command's: scoped services (the `Translator` in `APP_LOCALE`) live as long as the session.
  The log carries no request context.
- **TypeScript:** the input goes through Node's `module.stripTypeScriptTypes()` — the same erasable syntax as the app's files
  (no `enum`, no parameter properties; an `enum` is an error that says so). Input that ends too early continues on the next line.
- **A result that is a promise is awaited** — `repos.users.count()` shows the number, as with `await`.
- **Completion:** the helpers and names, `repos.<Tab>`, `config.<Tab>`, `make(<Tab>` / `make('<Tab>`, and route names in `url('<Tab>`.
- `.ls` lists the helpers, the repositories and the names; `.help` the commands.

### `--sandbox`: everything rolled back

```sh
marmeon tinker --sandbox
```

The whole session runs in one transaction on the default connection (E107) — the context holds from input to input — and
rolls back when the session ends: `.exit`, Ctrl-D, Ctrl-C twice, SIGINT/SIGTERM, an error of the process (a session that dies
never commits). Each input is a savepoint of its own: an input that fails takes back only its own writes, and on Postgres the
transaction stays usable after a failed statement. Jobs on the `database` queue join the transaction and are gone with it;
jobs on other queues and mails that wait for the commit (`afterCommit`) never go out.

What it does **not** undo: a mail sent directly, files written to a disk, Redis, HTTP calls — and the
[infrastructure](../database/README.md#infrastructure-connections-e108) (E108): the cache with its locks and rate limits and the
sessions write on a connection of their own, also inside the sandbox. On SQLite without a file of their own they cannot write
inside the transaction at all — tinker says so instead of waiting (`InfrastructureTransactionError` plus a hint); give them
their own file (`CACHE_CONNECTION`, `SESSION_CONNECTION`) or Redis.

> [!WARNING]
> **SQLite:** once a sandbox session wrote, it holds the file's write lock until it ends. Other processes — the dev server, a
> worker — still read, but their writes wait (5 s) and then fail with `database is locked`. Keep sandbox sessions short there.

### `--execute`: for scripts

```sh
marmeon tinker --execute "await repos.users.count()"          # prints 3
marmeon tinker -e "url('user-profile.show', { user: 1 })"     # prints /users/1 (strings as they are)
marmeon tinker --sandbox -e "await repos.users.insert({ … })"  # tries it, rolls back
```

Evaluates the code like one input of the REPL and prints the value (a string as it is, anything else inspected; nothing for
`undefined`) — only the value goes to stdout. An error prints its stack to stderr and exits with **1**.

### Production

`tinker` works in every environment: access to the server's shell is the gate (E122). Where the app is protected (production,
staging, no `NODE_ENV` — E139) the banner says so in red — `PRODUCTION — NODE_ENV=production, db pgsql (db.internal:5432/app):
every change is real.`, `PROTECTED (staging) — NODE_ENV=staging, …` (`--execute`: on stderr).
The banner names the driver, host and database, never a user or password. `--sandbox` is the safe way to look around.

### History

The inputs of interactive sessions are kept in `storage/framework/tinker_history` (1000 lines; Node creates it readable only by its owner — a file that exists already keeps its mode).
**It is plain text:** whatever you type — a password you hash, a token you paste — is in it. `--no-history` keeps none.
Values the REPL prints are not redacted: they are what you asked for (a `secret()` column you selected shows); the history
holds inputs only, never output, and the banner never shows a secret.

## Lint

`marmeon make:lint-config` writes an [oxlint](https://oxc.rs/docs/guide/usage/linter) config for the app (E121) —
`.oxlintrc.json` in the app root, yours to change (`--force` writes it anew):

```text
$ marmeon make:lint-config [--boundaries]
✓ Created .oxlintrc.json
$ pnpm add -D oxlint && pnpm exec oxlint
modules/auth/views/Login.tsx:3:1: error eslint(no-restricted-imports): '../controllers/ShowLoginController.ts' import is
  restricted from being used by a pattern. help: Client code (views, layouts, the client entry) imports server code —
  controllers, repositories, service providers, a module's entry (#modules/…) — only with `import type`: a value import
  bundles it, and everything it imports, into the browser.
```

**Client code imports server code as types only.** A view needs its controller's type (`PageProps<ShowLoginController>`),
never the class. `import { ShowLoginController }` is a value import even where only the type is used — with
`verbatimModuleSyntax` it stays in the output and drags the controller, and everything it imports (the session, the database
driver …), into the browser bundle. The preset restricts, in `modules/*/views/**`, `modules/*/layouts/**`, `layouts/**` and
`bootstrap/client.*`, imports of `**/controllers/**`, of `*Repository`/`*ServiceProvider` files and of module entries
(`#modules/<name>`) to `import type` (`no-restricted-imports` with `allowTypeImports`), and everywhere
`import { type X }` to `import type { X }` (`typescript/no-import-type-side-effects`): the inline form also stays in the
output, as `import {} from …`, and loads the module.

oxlint sees the import's text, not the file it resolves to. The authoritative check is the `marmeon()` Vite plugin's: it
resolves every import of client code, follows indirect ones (view → helper → controller) and knows more server modules
(jobs, listeners, mails, policies, `config/` …) — an error in the dev overlay and a failed build, without a linter
([Server code in the browser](../vite/README.md#server-code-in-the-browser-e121)). The preset shows the common case in the editor.

**`--boundaries` (opt-in, Leitprinzip 5):** a module imports another module only through its entry —
`import { MemberStats } from '#modules/user-profile'` (the app's `package.json` maps `"#modules/*": "./modules/*/index.ts"`),
never `../../user-profile/MemberStats.ts`. The module's `index.ts` decides what it shares; its tables stay its own with
`Database<'module'>` and `exposes` (E20). Tests may reach into any module (factories, jobs). Without the flag nothing about
module structure is checked — Marmeon imposes no architecture.

Why the generated file is long: oxlint matches import specifiers as text, so "leaves the module" depends on the folder depth
(`../billing/x.ts` from `modules/auth/a.ts`, `../../billing/x.ts` from `modules/auth/listeners/b.ts` — but
`../notifications/n.ts` from there is the module's own `notifications/` folder). The preset has one override per depth
(eight, more when the app's modules go deeper), and a later override replaces an earlier one's options for the same rule, so
the client folders carry both rules. The patterns are gitignore globs with negations (`!../*/index.*`): oxlint's `regex`
has no lookaround, and a regex it cannot compile is dropped without a word — the generator's test lints a fixture app to
prove every pattern fires. Two more oxlint findings: its `ignorePatterns` filters what it reports but still walks the
directories — only a `.gitignore` (or `--ignore-pattern`) keeps it out of `node_modules`; without one, the walk through pnpm's
links took 30 s and more (the blank app now has its own `.gitignore`). And a nested `.oxlintrc.json` replaces the one above it
instead of merging (an app's preset is complete on its own).

**Before E121**, nothing enforced `import type` (W7 plan, finding 8). A value import of a controller in a view failed the
build only by accident — after 144 "externalized for browser compatibility" warnings, with
`Rolldown failed to resolve import "@oxc-parser/binding-wasm32-wasip1"` (core's injection analyzer pulls in oxc-parser), and
the view named nowhere; a server module that did not reach `@marmeon/core` built green and shipped its code. The dev
server showed the same unrelated error in the overlay, and the page did not hydrate.

**The repository** lints itself with `pnpm lint` (`oxlint --deny-warnings`, part of `pnpm run ci`): the root
`.oxlintrc.json` (oxlint's correctness rules as errors, plus `no-import-type-side-effects`; off with a reason: unused
private brands such as `readonly #event = true`, deliberate copies before deleting while iterating, `this` aliases that walk a
parent chain). The apps carry the generated preset — `apps/web-app` with `--boundaries`, `apps/blank-app` without — which
oxlint takes for their files instead (nested configs do not merge). `make:auth` does not write a lint config (it belongs to
the app, not to a module); the make:auth fixture test lints the generated module with and without `--boundaries`.
