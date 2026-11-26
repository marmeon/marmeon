# Commands, Checks & Jobs

## Introduction

A package brings console commands, checks for [`marmeon check`](check.md) and jobs for a worker as statics of its service provider. This page continues the `@acme/marmeon-request-log` package of [Package Development: Getting Started](package-development.md) with its command and a check, and shows a job on an example of its own.

## Commands

A package lists its commands as `static commands` on its provider. The CLI collects them while the app registers, before anything
boots, so `marmeon build` sees them and stops on a name that is taken twice; the message names both commands and the provider.
`marmeon` stays an optional peer dependency — the command files import only its types. A command is a class like any
[command of an app](console.md#writing-commands):

```ts title="src/PruneRequestLogCommand.ts"
import type { CommandInput } from 'marmeon';
import { RequestLogConfig } from './RequestLogConfig.ts';
import { RequestLog } from './RequestLog.ts';

export class PruneRequestLogCommand {
  static command = 'request-log:prune';
  static description = 'Delete request-log entries older than REQUEST_LOG_RETENTION_DAYS';

  readonly #log: RequestLog;
  readonly #config: RequestLogConfig;

  constructor(log: RequestLog, config: RequestLogConfig) {
    this.#log = log;
    this.#config = config;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const deleted = await this.#log.pruneOlderThan(this.#config.retentionDays);
    output.success(`Deleted ${deleted} request-log entries.`);
    return 0;
  }
}
```

Name a package's commands with a prefix of their own, such as `request-log:`. A package's commands always run in a booted app.
`static boots` is read for the framework's built-in commands only.

`DevProcesses` of `marmeon` adds a process that `marmeon dev` starts next to the server, as the queue does with its worker:
`app.container.make(DevProcesses).add({ name: 'request-log', args: ['request-log:watch'] })`. The arguments are those of a `marmeon` command.

### Registering what a generator writes

A generator that writes a class for a module can also list it there. `editDefinitionFile` of `@marmeon/core` adds an entry to a list of the object that `defineModule` or `defineApplication` receives, together with the imports it needs. It only inserts: the rest of the file stays as it was, comments, quotes and line endings included. Running it twice adds nothing the second time.

```ts
import { join } from 'node:path';
import { editDefinitionFile } from '@marmeon/core';

const outcome = editDefinitionFile(join(root, 'bootstrap', 'app.ts'), {
  define: { name: 'defineApplication', from: '@marmeon/core' },
  key: 'modules',
  add: { element: (names) => names.requestLog!, position: 'last' },
  imports: [{ name: 'requestLog', from: '#modules/request-log', kind: 'default' }],
});
```

The outcome is `added` (the file is written), `present` (the entry is already there) or `manual`. A file the editor does not understand
is `manual` and stays untouched: a list held in a variable, a spread that could set the key, two `defineModule` calls, a name that
is already bound to something else (a constant, class, type, interface, namespace or `import … = require()`), a file that is not writable. The generator then prints the reason and the lines to add by hand. `add: { value }` sets a
property such as `migrations` instead of a list entry. `editDefinition` does the same on a source string, and `importedBindings`
lists a file's imports for a generator that follows one.

The reasons name the file by its path. Pass an app-relative name as the third argument, `editDefinitionFile(file, edit, 'bootstrap/app.ts')`, so that a message does not show an absolute path.

A generator that writes a migration names the file with `nextMigrationStamp(root)` of `@marmeon/core`: the later of now and one second after the newest migration of every module, so the file runs after the tables it builds on whichever module holds them. It reads file names under `modules/*/migrations`, imports nothing and writes nothing. A generator that writes several migrations calls it again after each write. A migrations folder an app registers elsewhere is seen only by the booted migrator, not by the helper.

It throws an error that names the file and says to rename it when the newest stamp lies in the future and has a field out of range (month 1-12, day 1-31, hour up to 23, minute and second up to 59) or leaves no room behind it. A day past the end of its month (`2026_02_31_…`) is not refused: it rolls into the next month. A stamp in the past is never a reason.

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextMigrationStamp } from '@marmeon/core';

const stamp = nextMigrationStamp(root);
writeFileSync(join(root, 'modules', 'billing', 'migrations', `${stamp}_create_invoices_table.ts`), contents);
```

A migration with a `schema.data()` step should hold its function and its data itself, as source and as `JSON.parse` of JSON text: see [a data step a generator writes](migrations.md#a-data-step-a-generator-writes).

## Checks

A package adds checks to [`marmeon check`](check.md) as `static checks` on its provider, a module as `checks` in its definition.
A check is a class with `static check` (its name, in kebab-case) and `static phase`, and a `handle()` that returns what it found:

```ts title="src/RequestLogTableCheck.ts"
import type { AppCheck, CheckProblem } from 'marmeon';
import { RequestLog } from './RequestLog.ts';

export class RequestLogTableCheck implements AppCheck {
  static check = 'request-log-table';
  static phase = 'run' as const;

  readonly #log: RequestLog;

  constructor(log: RequestLog) {
    this.#log = log;
  }

  async handle(): Promise<readonly CheckProblem[]> {
    if (await this.#log.hasTable()) return [];
    return [{ severity: 'error', message: 'The request-log table is missing', fix: 'marmeon migrate', docs: 'docs/request-log.md#installation' }];
  }
}
```

`static phase = 'build'` is for a check that reads only what registering the app builds, with no secret and no connection; `'run'`
is for anything that reads configuration or opens a connection, and gets the booted app. The check is built through the container in
a scope of its own. `handle()` is given `{ signal }`, aborted when the time is up: release what you opened. Return `{ skipped: 'why' }` instead of findings when the check should not run here, or `{ problems, silenced }` to report findings a comment of the app silenced (each with its `reason`; one without a reason is a finding, not silenced). A finding is a [`CheckProblem`](check.md#json-output); its message is masked by the app's redactor, but name no secret in it.
A check that throws, or takes longer than a minute (`static timeout` sets it: seconds, or a `Duration` like `{ minutes: 2 }`, at most ten minutes; more stops the start with `K13`), ends as `error`, never as another check's result.

A bad or duplicate check name stops every command, not only `marmeon check`, as a command name used twice does. The name must be unique, in kebab-case, and none of `types`, `lint`, `internal-imports`, `raw-sql`, `inner-html`, `agents`, `packages`, `boot` or `readiness`; the app does
not start otherwise, and the message names both checks. A check that asks whether the package's service is reachable is not a
check but a [health check](health.md#writing-a-health-check): `marmeon check` runs those as `readiness`.

## Jobs

A package brings jobs as `static [providerJobs]` on its provider, a module as `jobs` in its definition. The app needs no entry for the jobs. A worker runs them when the provider is registered (discovered or by hand) and the app has `@marmeon/queue` with its provider. `MediaStore` stands for a service of your package, and `valibot` belongs in its `dependencies`.

```ts title="src/ProcessMediaJob.ts"
import type { JobPayload } from '@marmeon/queue';
import * as v from 'valibot';
import { MediaStore } from './MediaStore.ts';

export class ProcessMediaJob {
  static job = 'media.process';
  static schema = v.object({ mediaId: v.number() });

  readonly #store: MediaStore;

  constructor(store: MediaStore) {
    this.#store = store;
  }

  async handle(payload: JobPayload<typeof ProcessMediaJob>): Promise<void> {
    await this.#store.process(payload.mediaId);
  }
}
```

```ts title="src/MediaServiceProvider.ts"
import { providerJobs, type ServiceProvider } from '@marmeon/core';
import { ProcessMediaJob } from './ProcessMediaJob.ts';

export class MediaServiceProvider implements ServiceProvider {
  static [providerJobs] = [ProcessMediaJob];
}
```

The job class is the one [queues](queues.md#the-job-class) describes. The app checks a provider's jobs when it starts, as it checks a module's. Each class needs a name, a schema and `handle()`. No name may belong to two classes. An encrypted job needs the `EncryptionServiceProvider` of `@marmeon/encryption`.

A `static [providerJobs]` that is no list stops the start with `Q4`. On a provider with nothing else, `K9` refuses an empty list, a string, `null` or a `Set` before that. A plain `static jobs` or `static providerJobs` is never read. `marmeon` reads the list as well, to count the jobs as listed, to name them in tinker and to list them in `modules:list`. Listing a class twice, in a module and a provider or in two providers, is no error.

A build with `isolatedDeclarations` refuses the computed key (TS9038). Set the list in a static block there, with `import type { JobClass } from '@marmeon/queue'`: `static { Object.assign(this, { [providerJobs]: [ProcessMediaJob] satisfies readonly JobClass[] }); }`. Keep the `satisfies`, because nothing else checks the list's type. The list is then not in the `.d.ts`: a subclass that sets the key replaces it without a type error, so it sets its list in a static block too and spreads `(Parent as ServiceProviderClass)[providerJobs] ?? []`, with `import type { ServiceProviderClass } from '@marmeon/core'`. Such a build also needs a type on the job's `schema`, such as `StandardSchemaV1<{ mediaId: number }>`.

- **Name:** Start the job's name with the package's name and a dot (`media.process`), not a colon, because the locks of a job join a name and a key with a colon (see [Unique jobs](queues.md#unique-jobs)). The name is the stored format of every record. A name that another package or the app uses stops the app at the start. Names under `marmeon.` belong to the framework and are refused. The whole app shares the keys of `job.once` and of `withoutOverlapping(…, { shared: true })`, so start them with the package's name too.
- **Peer dependency:** List `@marmeon/core` and `@marmeon/queue` as peer dependencies, each with the range of the release that adds `static [providerJobs]`: an older core has no `providerJobs` export, and an older queue ignores the static, so the dispatch throws. Where the queue is optional, import it with `import type { … }`, not `import { type … }`, so the file has no import of it at run time. An app without the queue package then starts as usual, and nothing registers the jobs. Write the static as a plain list of classes: `marmeon` reads it without the queue and in the build phase, where the app's environment may be missing.
- **Timeout:** A worker checks every job's `static timeout` when it starts, as it does for a module's job. With the default `retryAfterSeconds` of 90 and `--stop-timeout` of 10, a timeout of 80 seconds or more refuses the worker. The message names your provider, unless a module lists the job too. Keep the timeout well below that, or tell your users to raise `retryAfterSeconds`.
- **Constructor injection:** Export the job class from the package's entry, or build the package with `marmeon package:build`.

  ```ts title="src/index.ts"
  export { ProcessMediaJob } from './ProcessMediaJob.ts';
  export { MediaServiceProvider } from './MediaServiceProvider.ts';
  ```

  The rules for the injection lists of a package's classes, the re-exports included, are those of [injected classes](package-development.md#injected-classes); they apply to a job class as well.
- **Subclasses:** A provider meant to be extended annotates `static [providerJobs]: readonly JobClass[] = [ProcessMediaJob]`, with `import type { JobClass } from '@marmeon/queue'`. The annotation lets a subclass add a class with another payload. A subclass that adds jobs spreads the parent's: `static override [providerJobs] = [...super[providerJobs], ResizeMediaJob]`. A subclass of a job can give itself another name only where the parent declares `static job: string`. Otherwise, write a job class of its own.
- **Consent:** Installing a package is consent to run its jobs. Discovery also takes the dependencies of installed packages and the app's `devDependencies` where they are installed. With `discover: false` the app registers none of the installed packages, so you list the providers you want by hand ([without discovery](modules.md#without-discovery)). A waiting or failed record with the job's name runs in the class that has that name now, encrypted records included. The schema check and `static encrypted` still apply.

`marmeon modules:list` and the MCP server list the jobs of providers apart from the modules' own, see [listing the modules](modules.md#listing-the-modules).
