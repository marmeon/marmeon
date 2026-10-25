# Configuration

## Introduction

A Marmeon app reads its settings from environment variables. The app, each of its modules and each installed package declare
the variables they need as a config definition: a schema that checks the variables, and a function that turns them into a typed
value. The app checks every definition when it starts, so a missing or wrong variable stops the start before anything runs.

```ts title="config/app.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const AppConfig = defineConfig('app', {
  env: env({
    APP_NAME: env.string(),
    APP_URL: env.url(),
  }),
  resolve: (e) => ({ name: e.APP_NAME, url: e.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
```

A definition is also a service. A class that asks for `AppConfig` in its constructor gets the resolved value, `{ name, url }`.

## The environment files

The variables come from three places, and a later one wins over an earlier one:

1. `.env` in the app's root.
2. `.env.{NODE_ENV}` on top of it, for example `.env.test` while the tests run.
3. The real environment of the process: the shell, the container, the service manager.

An empty value counts as unset, also in a later place: `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=` in the process or in `.env.test`
gives the variable's default, not the value an earlier file sets. Only `NODE_ENV` has its own rule, in
[where `NODE_ENV` comes from](#where-node_env-comes-from).

A new app has three such files:

| File | In git | What it holds |
| --- | --- | --- |
| `.env` | no | The settings of this machine, with its application key. Readable by its owner only. |
| `.env.example` | yes | The common settings with a comment each, and no key. A colleague copies it to start. |
| `.env.test` | yes | What the tests run with: a test key, sessions and cache in memory, a database in memory. |

`.env.test` is committed, so put no real credentials in it.

A new app's `.gitignore` lists `.env*`, then `!.env.example` and `!.env.test`, so every other file, such as `.env.production`
or `.env.local`, stays out of git. Keep it that way: those files hold secrets.

`marmeon key:generate` writes a fresh `APP_KEY` into `.env`. When there is no `.env` yet, it copies `.env.example` first and
creates the file readable by its owner only. A `.env` that others could read is tightened to the same, and the command says so.
`marmeon make:docker` warns when a `.env.production` exists and git does not ignore it.

The app parses the files when it starts and leaves `process.env` as it is. The one exception is `NODE_ENV`, described below. So
read a setting through a config definition, not through `process.env`: only the definition sees the values from `.env`.

## The environment: `NODE_ENV`

Two variables describe where the app runs. `NODE_ENV` decides what the framework does, and it has exactly three values.
`APP_ENV` is the name you give the environment: it is shown, and it selects the scheduled tasks that run.

The app reads both through `EnvironmentConfig` of `@marmeon/core`, which every app has. `APP_ENV` is not part of your app's
`config/app.ts`: the framework's own parts, such as the start line and the logs, read it too.

`NODE_ENV` decides two things: whether the development tools run, and whether the protections apply. The two rules are not
mirror images of each other:

| `NODE_ENV` | Development tools | Protections |
| --- | --- | --- |
| `development` | on | off |
| `test` | off | off |
| `production`, or none | off | on |

Any other value stops the start, before anything of the app runs:

```text
✗ [marmeon:K6] Invalid environment — the application cannot start:
  • NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging. NODE_ENV is development, test or production; APP_ENV names the environment (docs/configuration.md#the-environment-node_env).
```

The development tools are Vite's dev server, the error page with the code that threw, the devtools, the `Server-Timing` header,
the mail previews, readable logs and the table types that `migrate` writes. The protections are JSON logs, `migrate` asking for
`--force` and the warnings at start-up. In addition, a write in a request that may only read is dropped and logged instead of
thrown.

The protections fail closed. A server where nobody set `NODE_ENV` is protected like production, because a forgotten variable must
never show your source code to a visitor. There is no switch to turn this off: set `NODE_ENV=development` on your own machine, and
nowhere else.

### `APP_ENV`: the environment's name

`APP_ENV` names the environment: `local`, `staging`, `production` or a name of your own. Without it, the name follows `NODE_ENV`:

| `NODE_ENV` | `APP_ENV` when it is not set |
| --- | --- |
| `development` | `local` |
| `test` | `testing` |
| `production`, or none | `production` |

The name appears in the start line, as the `appEnv` field of every JSON log entry, as `deployment.environment.name` on every span
the framework records, and in the header of the devtools. It also selects which scheduled tasks run: a task with
`.environments('staging')` runs where `APP_ENV=staging`, and one with `.environments('production')` does not run there, as the
[scheduling](scheduling.md#conditions) page shows. That is all it does. `APP_ENV` never weakens a protection and
never enables a development tool: `APP_ENV=local` on a server with `NODE_ENV=production` is protected, and its development routes
answer 404.

### Where `NODE_ENV` comes from

The `marmeon` command decides `NODE_ENV` once, before it loads anything of the app:

1. The process's own `NODE_ENV` wins.
2. Otherwise the one in `.env`. A new app's `.env` says `development`, so the commands on your machine run in
   development — except `marmeon start`, which refuses a `development` or `test` that comes from `.env` alone.
3. Otherwise the command's own default: `marmeon start` and `marmeon build` use `production`, `marmeon dev` uses `development`.
   Every other command runs without one, which is production.

Only the base `.env` can set it. A `.env.production` is chosen by `NODE_ENV=production`, so it cannot choose it: a `NODE_ENV` line
in it is ignored, with a warning. The value is written into `process.env.NODE_ENV`, so every part of the app reads the same one.
`APP_ENV` is read the same way as any other variable: the real environment, then `.env.{NODE_ENV}`, then `.env`.

`marmeon build` builds the browser code for production unless the environment itself says `NODE_ENV=development`. A
`development` from `.env` belongs to the commands of your machine, so the build sets it aside and says so; `test` builds for
production as well.

The start line says where the value came from, for example `development (APP_ENV=local, NODE_ENV from .env)`. A `.env` copied to a
server would turn the development tools on there, so `marmeon start` refuses it: with `NODE_ENV=development` or `NODE_ENV=test`
from `.env` alone it prints `marmeon start runs in production`, loads nothing of the app and exits with 1. Run `marmeon dev`,
set `NODE_ENV=production` to try the build, or set `NODE_ENV=development` in the real environment to start the development
stack on purpose. `queue:work` and `schedule:work` still run in that case, but each logs a loud warning that begins with `NODE_ENV=development comes from .env,
not from the environment`. On a server, set `NODE_ENV` in the real environment.

### Staging

A staging server runs as production and says so in its name:

```sh
NODE_ENV=production APP_ENV=staging marmeon start
```

It gets every protection and the production builds of the framework and of React, so a server error reaches the visitor as a
plain error page, never with its message or stack. The start line reads `production (APP_ENV=staging)`, and its logs and traces
carry the name. The [deployment](deployment.md#staging) page shows the image and the variables.

### Asking for the environment in code

`environment` from `@marmeon/core` answers the questions of the tables above. Ask `isProtected()` where your code protects
something, and `isDevelopment()` where it offers a development tool. Never compare `NODE_ENV` with `'production'`: that would
treat a missing value as development. Never ask `APP_ENV` whether to protect something either: it is a name, not a switch.

```ts title="config/demo.ts"
import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

export const DemoConfig = defineConfig('demo', {
  env: env({
    NODE_ENV: env.string().optional(),
    DEMO_DELAY_MS: env.integer().min(0).max(10_000).default(0),
  }),
  // A delay to watch a slow page load — never where the app is protected.
  resolve: (e) => ({ delayMs: environment.isProtected(e) ? 0 : e.DEMO_DELAY_MS }),
});
export type DemoConfig = ConfigOf<typeof DemoConfig>;
```

Inside `resolve`, pass its argument on: it is the environment the definition was checked against, which a test may set itself. Outside
a definition, the functions read `process.env`. `environment.isTest()`, `environment.name()`, `environment.app()` and
`environment.describe()` complete the set. `describe()` returns what the start line shows, such as `production (APP_ENV=staging)`.

To show the environment's name, ask for `EnvironmentConfig`. Every app has it, and it reads `NODE_ENV` and `APP_ENV` like any other
variable, so an `APP_ENV` in `.env` counts too:

```ts title="modules/system/controllers/ShowStatusController.ts"
import { EnvironmentConfig } from '@marmeon/core';

export class ShowStatusController {
  readonly #environment: EnvironmentConfig;

  constructor(environment: EnvironmentConfig) {
    this.#environment = environment;
  }

  handle() {
    // { node: 'production', app: 'staging' } on a staging server
    return { environment: this.#environment.app };
  }
}
```

Code that also runs in the browser cannot import `environment`. It checks the value inline, and positively:
`process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'`. The client build replaces the expression with the
value `marmeon build` ran under, and server rendering reads it when it runs.

## Defining configuration

### Reading variables

`env({ … })` from `@marmeon/core` is the schema of a definition. Its keys are the variables, and each one gets a building block
that reads the variable's text: `env.integer()` makes `'25'` the number 25, `env.boolean()` makes `'true'` the value `true`. A
default goes into the block, and `resolve` turns the values into the shape your code wants:

```ts title="modules/notes/config.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const NotesConfig = defineConfig('notes', {
  env: env({
    NOTES_PER_PAGE: env.integer().min(5).max(100).default(25),
    NOTES_SHARING: env.boolean().default(false),
    NOTES_EDITORS: env.list(env.email()).default([]),
    NOTES_EXPORT_URL: env.url({ protocols: ['https'] }).optional(),
  }),
  resolve: (e) => ({ perPage: e.NOTES_PER_PAGE, sharing: e.NOTES_SHARING, editors: e.NOTES_EDITORS, exportUrl: e.NOTES_EXPORT_URL }),
});
export type NotesConfig = ConfigOf<typeof NotesConfig>;
```

`NOTES_EDITORS=ada@example.com, alan@example.com` becomes a list of two addresses, and each one is checked. `ConfigOf<typeof
NotesConfig>` is the type that `resolve` returns, and `resolve` sees each variable with its type: `NOTES_PER_PAGE` is a `number`,
`NOTES_EXPORT_URL` a `string | undefined`.

These are the building blocks:

| Block | Reads | Narrowed by |
| --- | --- | --- |
| `env.string()` | Any text. | `.min(n)` and `.max(n)` characters, `.regex(pattern, message?)` |
| `env.integer()` | A whole number, written in decimal: `25`, `-1`. | `.min(n)`, `.max(n)` |
| `env.number()` | A number, decimals too: `0.5`. | `.min(n)`, `.max(n)` |
| `env.boolean()` | `true` or `false`, `1` or `0`, in any case. Any other text is an error, not `false`. | |
| `env.in(['sqlite', 'pgsql'])` | One of the values, case-sensitive. Its type is their union, `'sqlite' \| 'pgsql'`. | |
| `env.url()` | An absolute URL with `//`: `http://` or `https://`. `env.url({ protocols: ['redis', 'rediss'] })` takes others. | |
| `env.port()` | A port from 1 to 65535. | |
| `env.email()` | An e-mail address. | |
| `env.list(block)` | A list split at commas, each entry trimmed and read by `block`. Empty entries are dropped. `env.list(block, { separator: ';' })` splits at another character. | |

Every block ends in one of three ways, which decide what a missing variable means:

| Ending | A missing variable |
| --- | --- |
| none | Stops the start: `NOTES_TOKEN is required.` |
| `.default(value)` | Is `value`. The default has the block's type: `env.integer().default(25)`, not `'25'`. |
| `.optional()` | Is `undefined`. |

An empty variable, such as `NOTES_PER_PAGE=`, counts as missing, for every block: a `.env` file has no other way to say "not set".
So `NOTES_PER_PAGE=` gives the default 25, and an empty required variable stops the start like a missing one.

`.default()` and `.optional()` come last. `env.integer().default(25).min(5)` is a compile error, and so is a default of the wrong
type, a `.min()` on a boolean, and a variable that `resolve` reads but `env({ … })` does not declare.

### Messages of your own

A block's own message names the variable and what it expects, such as `NOTES_PER_PAGE must be at least 5.` It never repeats the
value, because a variable may hold a secret. Each block and each narrowing takes a message of its own as its last argument, and
`.check()` adds a rule of your own. `.required(message)` says what to do about a missing variable:

```ts title="modules/billing/config.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

const isTaxRate = (rate: number) => [0, 7, 19].includes(rate);

export const BillingConfig = defineConfig('billing', {
  env: env({
    BILLING_API_KEY: env.string().required('Missing — create a key in the billing dashboard'),
    BILLING_TAX_RATE: env.integer().check(isTaxRate, 'Expected 0, 7 or 19').default(19),
    BILLING_COUNTRIES: env.list(env.string().regex(/^[A-Z]{2}$/, 'Expected country codes like DE,AT')).default(['DE']),
    BILLING_DEFAULT_COUNTRY: env.string().default('DE'),
  }).check((e) => e.BILLING_COUNTRIES.includes(e.BILLING_DEFAULT_COUNTRY), 'BILLING_DEFAULT_COUNTRY must be one of BILLING_COUNTRIES', 'BILLING_DEFAULT_COUNTRY'),
  resolve: (e) => ({ apiKey: e.BILLING_API_KEY, taxRate: e.BILLING_TAX_RATE, countries: e.BILLING_COUNTRIES, defaultCountry: e.BILLING_DEFAULT_COUNTRY }),
});
export type BillingConfig = ConfigOf<typeof BillingConfig>;
```

`.check()` on `env({ … })` relates variables to each other. It runs once every variable was read without a problem, and its
message belongs to the variable its third argument names.

The schema can also come from any library that implements Standard Schema, such as Zod or Valibot. Then the library decides how
an empty variable is read.

### Renamed variables

When a variable gets a new name, an app that still sets the old one would silently run on the default of the new one: a page
size, a session lifetime or a list of trusted proxies that is suddenly not what the deployment says. `.renamed(from, to)` retires
the old name instead. A start with the old name set (and not empty) stops with a problem that names the new one, in every
environment and even when the new name is set as well. The old value is never read:

```ts title="modules/notes/config.ts"
export const NotesConfig = defineConfig('notes', {
  env: env({
    NOTES_PER_PAGE: env.integer().min(5).default(20),
  }).renamed('NOTES_PAGE_SIZE', 'NOTES_PER_PAGE'),
  resolve: (e) => ({ perPage: e.NOTES_PER_PAGE }),
});
```

`renamed()` throws when a name is not in upper case, when both names are the same, when the new name is not a variable of the
schema, when the old one is, and when the old one is retired already.

Reading both names would leave it open which one wins when a deployment sets both, so the old one only stops the start. Leave
the `.renamed()` call in place: without it, the old name falls back to the default again, silently.

### Where a definition is listed

A definition counts once it is listed, and it is checked once, however often it is listed:

| Where | For |
| --- | --- |
| `defineApplication({ config: [AppConfig] })` in `bootstrap/app.ts` | The app's own settings. |
| `defineModule({ config: [NotesConfig] })` in a module's `index.ts` | A module's settings. See [modules](modules.md#defining-a-module). |
| `static config = [LogConfig]` on a service provider | A package's settings. See [service providers](providers.md#what-a-provider-brings-besides-code). |

A definition is listed, not found by scanning `config/`, for these reasons:

- **The definition is already imported.** It is the type and the token the container resolves (`defineConfig()` makes a unique
  key for it), so any code that reads the configuration imports it anyway. Listing it is one more entry in an array.
- **Not every file in `config/` is a definition.** A file there may be loaded only in some environments, such as the
  devtools' settings, which must never load in production. A scan would load it.
- **A module brings its own.** Its definitions sit in the module's folder, and the module lists them, so removing the module
  removes its settings too.

### Using configuration

Ask for the definition in a constructor, like any other service:

```ts title="modules/notes/controllers/ListNotesController.ts"
import { Controller } from '@marmeon/http';
import { NotesConfig } from '../config.ts';

export class ListNotesController extends Controller {
  readonly #config: NotesConfig;

  constructor(config: NotesConfig) {
    super();
    this.#config = config;
  }

  handle() {
    return this.view('notes/Index', { perPage: this.#config.perPage });
  }
}
```

Import the definition as a value, not with `import type`. Its name is both the type and the token the container resolves, and
a type-only import does not exist when the app runs. The [service container](container.md#constructor-injection) page explains why.

## Values for the browser

A page reaches configuration through the server. Read the value from a definition in a controller and pass it as a page prop,
or share it with every page through [`SharedData`](responses.md#shared-props):

```ts title="middleware/ShareAppProps.ts"
declare module '@marmeon/http/page' {
  interface SharedProps {
    app?: { name: string; mapsKey: string };
  }
}

// In handle(), with a config definition injected next to SharedData:
this.#shared.share('app', { name: this.#config.name, mapsKey: this.#config.mapsKey });
```

A component reads it with `usePage().props`, typed by `interface SharedProps`. Only a value that is safe to publish belongs
there, such as the app's name or a public key. A secret stays out, because everything shared is sent to the browser.

Values take this route for two reasons. The server reads the configuration when it starts, so one build runs
unchanged in every environment, and `marmeon build` needs no `.env`. And nothing reaches the browser unless code hands it over,
so a variable is never published by being in the environment. The [Vite page](vite.md#server-code-in-the-browser) explains
the same rule for imports.

Vite's own `VITE_*` variables are switched off: `marmeon()` reads no `.env` file and publishes no variable through
`import.meta.env`, so an environment variable never reaches the bundle by its name. A value fixed at build time would differ
between the dev server and the build, and would bypass the validation of a definition. An app that needs them anyway sets
`marmeon({ viteEnv: true })`; see [Environment variables](vite.md#environment-variables).

## When a value is wrong

The app checks every definition before any provider registers, and collects every problem before it stops. One start shows
everything to fix:

```text
[marmeon:K6] Invalid configuration — the application cannot start:
  • notes: NOTES_PER_PAGE — NOTES_PER_PAGE must be at most 100.
  • notes: NOTES_EDITORS — NOTES_EDITORS entry 2 must be an e-mail address.
  • encryption: APP_KEY — Missing — run "marmeon key:generate"
Set these variables in the environment or in .env (see .env.example).
```

Each line names the definition, the variable as it is written, and the problem. A variable has one line, however much is wrong
with it. The `marmeon` command prints how to fix it
below the error, such as the command that generates a key.

## Configuration and the build

`marmeon build` needs no `.env` and no key. It loads the app to write the route types, registers every service provider and
boots none of them. A definition that does not validate without `.env`, such as the one that needs `APP_KEY`, is left out
instead of failing the build. So no secret can end up in what the build writes.

Reading such a definition while the build runs throws an error that names its variables. Read configuration in a provider's
`boot()`, in a request, a job or a command, never in a provider's `register()`. The [service
providers](providers.md#register-and-boot) page explains the two phases.

Nothing of the configuration is cached. Every start reads the environment and `.env` again, so a changed variable needs a
restart, not a new build.

## The variables of a new app

These are the settings a new app starts with. Each feature's page lists its own variables.

| Variable | Default | Effect |
| --- | --- | --- |
| `NODE_ENV` | the command's | `development`, `test` or `production`; any other value stops the start. `development` turns the development tools on; `production` and none are protected. |
| `APP_ENV` | `local`, `testing` or `production`, by `NODE_ENV` | The environment's name in the start line, the logs and the traces, and what `.environments()` of a scheduled task compares against. It never weakens a protection or enables a development tool. |
| `APP_NAME` | none, required | The app's name. The starter kit shows it on its pages and in its mails. |
| `APP_URL` | none, required | The app's address. `https://` makes the cookies `Secure`, unless `SESSION_SECURE_COOKIE` says otherwise. |
| `APP_KEY` | none, required | The key that encrypts cookies and signs URLs: `base64:` and 32 random bytes. |
| `APP_PREVIOUS_KEYS` | empty | Former keys, comma-separated. What they encrypted or signed stays valid. |
| `PORT` | `3000` | The port the server listens on. `0` takes a free one. |
| `HOST` | `127.0.0.1` | The interface the server listens on. `0.0.0.0` for other machines. |
| `LOG_LEVEL` | `info` | The lowest level that is logged, or `silent`. |
| `DB_DRIVER` | `sqlite` | `sqlite` or `pgsql`. |
| `DB_DATABASE` | `storage/database.sqlite` | The SQLite file, or the name of the Postgres database, which has no default: set it or `DB_URL`, or the start fails. |
| `DB_HOST` | `127.0.0.1` | Postgres: the server. |
| `DB_PORT` | `5432` | Postgres: its port. |
| `DB_USERNAME` | `postgres` | Postgres: the user. |
| `DB_PASSWORD` | empty | Postgres: the password. |
| `DB_URL` | none | Postgres: the whole address instead. When it is set, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD` are not read. |
| `SESSION_DRIVER` | `file` | Where sessions live: `file`, `database`, `redis` or `memory`. |
| `CACHE_DRIVER` | `file` | Where the cache lives: `file`, `database`, `redis`, `memory` or a driver a package brings. |
| `QUEUE_DRIVER` | `database` | Where queued jobs wait: `database`, `redis`, `sync` or a driver a package brings. |
| `MAIL_DRIVER` | `log` | `log` writes every mail to the log, `smtp` sends it, `array` keeps it in memory. |

## Every variable

Every variable the framework's packages read, from the `Environment` sections of their API snapshots. The list is frozen: a
variable is renamed with `.renamed()` ([Renamed variables](#renamed-variables)) and never given a retired name again, and a test
holds this table to the code. A feature's page explains its variables; the last column links it.

The names follow a few rules:

- A variable starts with the prefix of its area (`APP_`, `AUTH_`, `HASH_`, `CACHE_`, `CSRF_`, `DB_`, `DEVTOOLS_`, `LIVE_`, `LOG_`,
  `MAIL_`, `NOTIFICATIONS_`, `QUEUE_`, `REDIS_`, `SCHEDULE_`, `SERVER_`, `SESSION_`, `UPLOADS_`, `MARMEON_OTEL_`). Only `NODE_ENV`,
  `PORT` and `HOST` have none, because platforms set them, and the names of the OpenTelemetry specification stay as it writes them.
- `<AREA>_DRIVER` picks the driver. `<AREA>_CONNECTION` names a connection of the database or of Redis, and nothing else.
- A duration says its unit: `_MILLISECONDS`, `_SECONDS`, `_MINUTES`, `_HOURS` or `_DAYS`. A rate ends in `_PER_MINUTE` or
  `_PER_DAY`, a size in `_MB`.
- A switch is read as a boolean: `true`, `false`, `1` or `0`, in any case, and anything else stops the start. `OTEL_SDK_DISABLED` is the one exception: it
  follows the OpenTelemetry specification, where only `true`, in any case, disables the SDK. Any other value, `1` included, leaves spans on
  and logs a warning ([Observability](observability.md#configuration)).
- A rename keeps the unit, the default and the limits, so an app renames a key and never converts a value.

The Kind column says which rule a variable falls under: `driver`, `connection`, `switch`, `duration` or `value` for the rest.

| Variable | Package | Kind | Default | Page |
| --- | --- | --- | --- | --- |
| `APP_ENV` | core, devtools, log, scheduler | value | optional | [Configuration](configuration.md#the-environment-node_env) |
| `APP_FALLBACK_LOCALE` | i18n | value | `"en"` | [Localization](localization.md#configuration) |
| `APP_KEY` | encryption | value | required | [Encryption](encryption.md#the-application-key) |
| `APP_LOCALE` | i18n | value | `"en"` | [Localization](localization.md#configuration) |
| `APP_LOCALES` | i18n | value | `[]` | [Localization](localization.md#configuration) |
| `APP_NAME` | auth, redis | value | optional | [Configuration](configuration.md#the-variables-of-a-new-app) |
| `APP_PREVIOUS_KEYS` | encryption | value | `[]` | [Encryption](encryption.md#the-application-key) |
| `APP_URL` | auth, devtools, mail, server, session | value | optional | [Configuration](configuration.md#the-variables-of-a-new-app) |
| `AUTH_ACCOUNT_SIGN_INS_PER_DAY` | auth | value | `100` | [Authentication](authentication.md#configuration) |
| `AUTH_DEVICE_COOKIE_DAYS` | auth | duration | `90` | [Authentication](authentication.md#configuration) |
| `AUTH_EMAIL_CHANGE_MINUTES` | auth | duration | `60` | [Authentication](authentication.md#configuration) |
| `AUTH_EMAIL_CHANGE_THROTTLE_SECONDS` | auth | duration | `60` | [Authentication](authentication.md#configuration) |
| `AUTH_LOGIN_ATTEMPTS_PER_MINUTE` | auth | value | `5` | [Authentication](authentication.md#configuration) |
| `AUTH_PASSKEY_ORIGINS` | auth | value | optional | [Passkeys](passkeys.md#requirements) |
| `AUTH_PASSKEY_RP_ID` | auth | value | optional | [Passkeys](passkeys.md#requirements) |
| `AUTH_PASSWORD_TIMEOUT_SECONDS` | auth | duration | `900` | [Authentication](authentication.md#configuration) |
| `AUTH_PRIVATE_REGISTRATION` | auth | switch | `true` | [Authentication](authentication.md#configuration) |
| `AUTH_REMEMBER_COOKIE` | auth | value | `"marmeon_remember"` | [Authentication](authentication.md#configuration) |
| `AUTH_REMEMBER_DAYS` | auth | duration | `30` | [Authentication](authentication.md#configuration) |
| `AUTH_RESET_MINUTES` | auth | duration | `60` | [Authentication](authentication.md#configuration) |
| `AUTH_RESET_THROTTLE_SECONDS` | auth | duration | `60` | [Authentication](authentication.md#configuration) |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | auth | switch | `false` | [Authentication](authentication.md#configuration) |
| `AUTH_SESSION_MAX_HOURS` | auth | duration | `24` | [Authentication](authentication.md#configuration) |
| `AUTH_TOKEN_PREFIX` | auth | value | `"marmeon_"` | [API Tokens](api-tokens.md#the-token-format) |
| `AUTH_UNVERIFIED_DAYS` | auth | duration | `7` | [Authentication](authentication.md#configuration) |
| `CACHE_CONNECTION` | cache | connection | `"default"` | [Cache](cache.md#configuration) |
| `CACHE_DRIVER` | cache | driver | `"file"` | [Cache](cache.md#configuration) |
| `CACHE_PATH` | cache | value | `"storage/framework/cache"` | [Cache](cache.md#configuration) |
| `CACHE_PREFIX` | cache | value | `""` | [Cache](cache.md#configuration) |
| `CSRF_TRUSTED_ORIGINS` | session | value | `[]` | [CSRF Protection](csrf.md#configuration) |
| `DB_DATABASE` | database | value | optional | [Database: Getting Started](database.md#configuration) |
| `DB_DRIVER` | database | driver | `"sqlite"` | [Database: Getting Started](database.md#configuration) |
| `DB_HOST` | database | value | `"127.0.0.1"` | [Database: Getting Started](database.md#configuration) |
| `DB_INFRA_POOL_MAX` | database | value | `4` | [Database: Getting Started](database.md#configuration) |
| `DB_MANAGED` | database | switch | `true` | [Database: Getting Started](database.md#configuration) |
| `DB_PASSWORD` | database | value | `""` | [Database: Getting Started](database.md#configuration) |
| `DB_POOL_MAX` | database | value | `10` | [Database: Getting Started](database.md#configuration) |
| `DB_PORT` | database | value | `5432` | [Database: Getting Started](database.md#configuration) |
| `DB_URL` | database | value | optional | [Database: Getting Started](database.md#configuration) |
| `DB_USERNAME` | database | value | `"postgres"` | [Database: Getting Started](database.md#configuration) |
| `DEVTOOLS_ENABLED` | devtools | switch | optional | [Devtools](devtools.md#only-in-development) |
| `HASH_ARGON_MEMORY` | auth | value | `19456` | [Hashing](hashing.md#configuration) |
| `HASH_ARGON_PARALLELISM` | auth | value | `1` | [Hashing](hashing.md#configuration) |
| `HASH_ARGON_TIME` | auth | value | `2` | [Hashing](hashing.md#configuration) |
| `HASH_DRIVER` | auth | driver | `"argon2id"` | [Hashing](hashing.md#configuration) |
| `HASH_SCRYPT_BLOCK_SIZE` | auth | value | `8` | [Hashing](hashing.md#configuration) |
| `HASH_SCRYPT_COST` | auth | value | `17` | [Hashing](hashing.md#configuration) |
| `HASH_SCRYPT_PARALLELISM` | auth | value | `1` | [Hashing](hashing.md#configuration) |
| `HOST` | server | value | `"127.0.0.1"` | [Configuration](configuration.md#the-variables-of-a-new-app) |
| `LIVE_CONNECTION` | live | connection | `"default"` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_DRIVER` | live | driver | `"memory"` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_HEARTBEAT_SECONDS` | live | duration | `20` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_MAX_CHANNELS` | live | value | `20` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_MAX_STREAMS` | live | value | `1000` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_MAX_STREAMS_PER_SESSION` | live | value | `16` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_MAX_STREAM_SECONDS` | live | duration | `900` | [Real-time Updates](realtime.md#configuration) |
| `LIVE_RETRY_MILLISECONDS` | live | duration | `3000` | [Real-time Updates](realtime.md#configuration) |
| `LOG_FORMAT` | log | value | optional | [Logging](logging.md#configuration) |
| `LOG_LEVEL` | log | value | `"info"` | [Logging](logging.md#configuration) |
| `MAIL_DRIVER` | mail | driver | `"log"` | [Mail](mail.md#configuration) |
| `MAIL_FROM_ADDRESS` | mail | value | optional | [Mail](mail.md#configuration) |
| `MAIL_FROM_NAME` | mail | value | `""` | [Mail](mail.md#configuration) |
| `MAIL_HOST` | mail | value | `"127.0.0.1"` | [Mail](mail.md#configuration) |
| `MAIL_PASSWORD` | mail | value | `""` | [Mail](mail.md#configuration) |
| `MAIL_PORT` | mail | value | `587` | [Mail](mail.md#configuration) |
| `MAIL_REQUIRE_TLS` | mail | switch | `true` | [Mail](mail.md#configuration) |
| `MAIL_SECURE` | mail | switch | `false` | [Mail](mail.md#configuration) |
| `MAIL_USERNAME` | mail | value | `""` | [Mail](mail.md#configuration) |
| `MARMEON_OTEL_RECORD_QUERY_VALUES` | otel | switch | `false` | [Observability](observability.md#configuration) |
| `MARMEON_OTEL_TRUST_TRACEPARENT` | otel | switch | `false` | [Observability](observability.md#configuration) |
| `NODE_ENV` | auth, core, devtools, encryption, log, mail, scheduler, server, session | value | optional | [Configuration](configuration.md#the-environment-node_env) |
| `NOTIFICATIONS_CONNECTION` | notifications | connection | `"default"` | [Notifications](notifications.md#the-notifications-table) |
| `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST` | otel | value | `[]` | [Observability](observability.md#redaction) |
| `OTEL_SDK_DISABLED` | otel | switch | `"false"` | [Observability](observability.md#configuration) |
| `PORT` | server | value | `3000` | [Configuration](configuration.md#the-variables-of-a-new-app) |
| `QUEUE_DATABASE_CONNECTION` | queue | connection | `"default"` | [Queues](queues.md#configuration) |
| `QUEUE_DATABASE_QUEUE` | queue | value | `"default"` | [Queues](queues.md#configuration) |
| `QUEUE_DATABASE_RETRY_AFTER_SECONDS` | queue | duration | `90` | [Queues](queues.md#configuration) |
| `QUEUE_DRIVER` | queue | driver | `"database"` | [Queues](queues.md#configuration) |
| `QUEUE_FAILED_CONNECTION` | queue | connection | optional | [Queues](queues.md#configuration) |
| `QUEUE_FAILED_DRIVER` | queue | driver | `"database"` | [Queues](queues.md#configuration) |
| `QUEUE_REDIS_CONNECTION` | queue | connection | `"default"` | [Queues](queues.md#configuration) |
| `QUEUE_REDIS_QUEUE` | queue | value | `"default"` | [Queues](queues.md#configuration) |
| `QUEUE_REDIS_RETRY_AFTER_SECONDS` | queue | duration | `90` | [Queues](queues.md#configuration) |
| `REDIS_PREFIX` | redis | value | optional | [Redis](redis.md#configuration) |
| `REDIS_URL` | redis | value | `"redis://127.0.0.1:6379"` | [Redis](redis.md#configuration) |
| `SCHEDULE_TIMEZONE` | scheduler | value | `"UTC"` | [Task Scheduling](scheduling.md#configuration) |
| `SERVER_ASSET_VERSION` | server | value | optional | [Deployment](deployment.md#configuration) |
| `SERVER_HEALTH_PATH` | server | value | `"/up"` | [Deployment](deployment.md#health-checks) |
| `SERVER_KEEP_ALIVE_TIMEOUT_SECONDS` | server | duration | `65` | [Deployment](deployment.md#configuration) |
| `SERVER_MAX_BODY_SIZE` | server | value | `"8m"` | [Requests](requests.md#configuration) |
| `SERVER_SHUTDOWN_DELAY_SECONDS` | server | duration | `0` | [Deployment](deployment.md#configuration) |
| `SERVER_SSR_ENABLED` | server | switch | `true` | [Pages & Layouts](pages.md#server-rendering) |
| `SERVER_TRUSTED_PROXIES` | server | value | `[]` | [Deployment](deployment.md#configuration) |
| `SESSION_CONNECTION` | session | connection | `"default"` | [Session](session.md#configuration) |
| `SESSION_COOKIE` | session | value | `"marmeon_session"` | [Session](session.md#configuration) |
| `SESSION_DRIVER` | session | driver | `"file"` | [Session](session.md#configuration) |
| `SESSION_ENCRYPT` | session | switch | `false` | [Session](session.md#configuration) |
| `SESSION_FILES` | session | value | `"storage/framework/sessions"` | [Session](session.md#configuration) |
| `SESSION_LIFETIME_MINUTES` | session | duration | `120` | [Session](session.md#configuration) |
| `SESSION_LOTTERY` | session | value | `"2/100"` | [Session](session.md#configuration) |
| `SESSION_SAME_SITE` | session | value | `"lax"` | [Session](session.md#configuration) |
| `SESSION_SECURE_COOKIE` | session | switch | optional | [Session](session.md#configuration) |
| `UPLOADS_CONNECTION` | storage | connection | `"default"` | [File Storage](storage.md#configuration) |
| `UPLOADS_DISK` | storage | value | `"uploads"` | [File Storage](storage.md#configuration) |
| `UPLOADS_LIFETIME_MINUTES` | storage | duration | `120` | [File Storage](storage.md#configuration) |
| `UPLOADS_MAX_OPEN` | storage | value | `20` | [File Storage](storage.md#configuration) |
| `UPLOADS_MAX_OPEN_MB` | storage | value | `1024` | [File Storage](storage.md#configuration) |
| `UPLOADS_MAX_OPEN_TOTAL_MB` | storage | value | `10240` | [File Storage](storage.md#configuration) |
| `UPLOADS_SEND_WITHIN_MINUTES` | storage | duration | `15` | [File Storage](storage.md#configuration) |

## Testing

Under Vitest, `NODE_ENV` is `test`, so `.env.test` applies on top of `.env`. A test changes single variables for its own app
instance:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NotesConfig } from './config.ts';

it('reads NOTES_SHARING', async () => {
  await using app = await createTestApp(application, { env: { NOTES_SHARING: 'true' } });
  expect(app.container.make(NotesConfig).sharing).toBe(true);
});
```

The [testing](testing.md#creating-the-test-app) page explains how a test boots the app.
