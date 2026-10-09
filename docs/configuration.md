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

A new app has three such files:

| File | In git | What it holds |
| --- | --- | --- |
| `.env` | no | The settings of this machine, with its application key. Readable by its owner only. |
| `.env.example` | yes | The common settings with a comment each, and no key. A colleague copies it to start. |
| `.env.test` | yes | What the tests run with: a test key, sessions and cache in memory, a database in memory. |

`marmeon key:generate` writes a fresh `APP_KEY` into `.env`. When there is no `.env` yet, it copies `.env.example` first.

The app parses the files when it starts and leaves `process.env` as it is. The one exception is `NODE_ENV`, described below. So
read a setting through a config definition, not through `process.env`: only the definition sees the values from `.env`.

## The environment: `NODE_ENV`

`NODE_ENV` decides two things: whether the development tools run, and whether the protections apply. The two rules are not
mirror images of each other:

| `NODE_ENV` | Development tools | Protections |
| --- | --- | --- |
| `development` | on | off |
| `test` | off | off |
| `production`, `staging`, any other value, or none | off | on |

The development tools are Vite's dev server, the error page with the code that threw, the devtools, the `Server-Timing` header,
the mail previews, readable logs and the table types that `migrate` writes. The protections are JSON logs, `migrate` asking for
`--force` and the warnings at start-up. In addition, a write in a request that may only read is dropped and logged instead of
thrown.

The protections fail closed. A staging server, a typo in `NODE_ENV` and a server where nobody set it are all protected like
production, because a forgotten variable must never show your source code to a visitor. There is no switch to turn this off:
set `NODE_ENV=development` on your own machine, and nowhere else.

### Where `NODE_ENV` comes from

The `marmeon` command decides `NODE_ENV` once, before it loads anything of the app:

1. The process's own `NODE_ENV` wins.
2. Otherwise the one in `.env`. A new app's `.env` says `development`, so every command on your machine runs in development.
3. Otherwise the command's own default: `marmeon start` and `marmeon build` use `production`, `marmeon dev` uses `development`.
   Every other command runs without one, and is protected.

Only the base `.env` can set it. A `.env.staging` is chosen by `NODE_ENV=staging`, so it cannot choose it: a `NODE_ENV` line in it
is ignored, with a warning. The value is written into `process.env.NODE_ENV`, so every part of the app reads the same one.

`marmeon build` is the exception to the second rule. A `development` from `.env` belongs to the commands of your machine, so the
build sets it aside, says so, and builds for production.

The start line says where the value came from, for example `development (from .env)`. A `.env` copied to a server would turn
the development tools on there. `marmeon start`, `queue:work` and `schedule:work` still run in that case, but each logs a loud
warning that begins with `NODE_ENV=development comes from .env, not from the environment`. On a server, set `NODE_ENV` in the
real environment.

### Staging

Marmeon takes its production branches under any `NODE_ENV` but `development` and `test`. React does not: it uses its production
build only with `NODE_ENV=production`, and its development build under every other value.

> [!WARNING]
> A staging server shows its server errors to whoever opens the page. With `NODE_ENV=staging`, React renders with its
> development build, and an error thrown in a part of a page that streams in after the first part reaches the browser with its
> message and its stack trace. Keep staging behind a login or in a private network, put no real customer data on it, and treat
> every message a server error can carry as visible to its visitors.

Build a staging image with `NODE_ENV=production` and set `staging` only when it runs. A client built under `NODE_ENV=staging`
carries React's development build into the browser as well. The [deployment](deployment.md#staging) page covers both.

### Asking for the environment in code

`environment` from `@marmeon/core` answers the questions of the table above. Ask `isProtected()` where your code protects
something, and `isDevelopment()` where it offers a development tool. Never compare `NODE_ENV` with `'production'`: that would
treat staging and a missing value as development.

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
a definition, the functions read `process.env`. `environment.isTest()`, `environment.name()` and `environment.describe()` complete
the set. `describe()` returns what the start line shows, such as `staging (protected)`.

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

### Where a definition is listed

A definition counts once it is listed, and it is checked once, however often it is listed:

| Where | For |
| --- | --- |
| `defineApplication({ config: [AppConfig] })` in `bootstrap/app.ts` | The app's own settings. |
| `defineModule({ config: [NotesConfig] })` in a module's `index.ts` | A module's settings. See [modules](modules.md#defining-a-module). |
| `static config = [LogConfig]` on a service provider | A package's settings. See [service providers](providers.md#what-a-provider-brings-besides-code). |

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

## When a value is wrong

The app checks every definition before any provider registers, and collects every problem before it stops. One start shows
everything to fix:

```text
Invalid configuration — the application cannot start:
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
| `NODE_ENV` | the command's | `development` turns the development tools on. Every value but `development` and `test` is protected. |
| `APP_NAME` | none, required | The app's name. The starter kit shows it on its pages and in its mails. |
| `APP_URL` | none, required | The app's address. `https://` makes the cookies `Secure`, unless `SESSION_SECURE_COOKIE` says otherwise. |
| `APP_KEY` | none, required | The key that encrypts cookies and signs URLs: `base64:` and 32 random bytes. |
| `APP_PREVIOUS_KEYS` | empty | Former keys, comma-separated. What they encrypted or signed stays valid. |
| `PORT` | `3000` | The port the server listens on. `0` takes a free one. |
| `HOST` | every interface | The interface the server listens on. |
| `LOG_LEVEL` | `info` | The lowest level that is logged, or `silent`. |
| `DB_CONNECTION` | `sqlite` | `sqlite` or `pgsql`. |
| `DB_DATABASE` | `storage/database.sqlite` | The SQLite file, or the name of the Postgres database. |
| `SESSION_DRIVER` | `file` | Where sessions live: `file`, `database`, `redis`, `cookie` or `memory`. |
| `CACHE_DRIVER` | `file` | Where the cache lives: `file`, `database`, `redis` or `memory`. |
| `QUEUE_CONNECTION` | `database` | Where queued jobs wait: `database`, `redis` or `sync`. |
| `MAIL_MAILER` | `log` | `log` writes every mail to the log, `smtp` sends it, `array` keeps it in memory. |

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
