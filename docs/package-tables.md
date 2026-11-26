# Tables & Migrations

## Introduction

A package that keeps tables in the app's database ships its migrations and the files it publishes, and the app copies them. This page covers the tables of a package, the migrations it declares and the files it publishes; it continues the `@acme/marmeon-request-log` package of [Package Development: Getting Started](package-development.md).

## Tables

A package that keeps tables in the app's database does not write them into the app itself. It ships the migrations as stubs, and
the app copies them. The contract has six parts:

1. **The directory.** The files lie in the directory `static migrations` names and are called `<timestamp>_<name>.ts`, such as
   `2026_01_01_000000_create_request_log_table.ts`. Name a file after its table, as an app does. They run in the order of their names,
   and a name without its timestamp is unique in the directory.
2. **Append-only.** A file that has shipped is never edited, renamed or deleted, because an app has copied it and its database has
   run it. A release that changes a table adds a file that sorts after every other in the directory. In the framework's repository, the "api label" check refuses a pull request that does otherwise.
3. **The plan.** `up(schema)` is synchronous and only describes the change; the app computes what it did without running it. Data
   changes go through `schema.data()` and nowhere else. A column that holds a secret, such as a token's hash, is marked
   `.secret()`. See [migration structure](migrations.md#migration-structure).
4. **The declaration and `publish`.** `static migrations` of your service provider names the directory of
   the stubs ([declaring the migrations a package ships](#declaring-the-migrations-a-package-ships)). `marmeon publish <package>`
   copies the files the app lacks ([publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package)),
   also after an update, and a command of your own can point the app to `marmeon publish <package>`.
5. **The requirements.** A table the package needs is registered with `SchemaRequirements` (from `@marmeon/database`). In `boot()`,
   take it with `app.container.make(SchemaRequirements)` once `app.container.has(Connections)`, and call
   `require({ connection, table, columns, secrets?, whenPresent? })`; a new instance checks nothing. `columns` are the columns
   the package reads and writes and `secrets` the ones that must be marked `.secret()`: readiness is red while the table
   is missing, lacks a column or has one unmarked, as in a table made by hand (not on a connection with `managed: false`). A
   requirement with `whenPresent: true` is for a table the app may never have made (the feature is unused): it is only checked once
   the table exists.
6. **No module with migrations.** A module's `migrations` must not point into the package's own folder in `node_modules`: the app
   refuses that with error D20, because a package update would change migrations the database has run. Ship the migrations as stubs
   the app copies.

Once a stub is on `main` it never changes and is never deleted: an app matches migrations by name, so an edit would reach new
apps and never the old ones. A change to a table is a new file that sorts after every file in its directory and has a name its
directory does not use yet. The repository's "api label" check refuses a pull request that does otherwise, whatever its labels.

### Declaring the migrations a package ships

The service provider of the package names the directory that holds the stubs that **create** its tables, and the module they go to:

```ts
import type { ServiceProvider } from '@marmeon/core';

export class RequestLogServiceProvider implements ServiceProvider {
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'request-log' };
  // …
}
```

`from` is a `file:` URL, built from `import.meta.url` so it names the same directory in `src/` and in the build: the path leads from
the file that holds the provider, so a provider in `src/provider.ts` writes `../stubs/migrations` and one in `src/request-log/provider.ts`
writes `../../stubs/migrations`. The static only declares the directory; it copies nothing. An app copies the files with
`marmeon publish <package>` ([publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package)), which
accepts only a direct dependency of the app. It reads `static migrations` of the providers the app boots, and imports the main
entry of each direct dependency a declaration points into (usually one the app has booted already).

The type is `ProviderMigrations` from `@marmeon/database`. A package that has `@marmeon/database` only as an optional peer writes
`satisfies ProviderMigrations` with an `import type`, or no annotation, so the type is checked while the package's `.d.ts` does
not mention the database.

Write `import type { X } from '…'`, not `import { type X } from '…'`: with `verbatimModuleSyntax` the second form still loads the
module, and an app without the optional peer cannot load the package.

Each file in the directory is named like a migration of an app, `<timestamp>_<name>.ts`, such as
`2026_01_01_000000_create_request_log_table.ts`. The migrations are read in the order of their file names. The timestamp only orders
the files within the package: `publish` gives a copy a new one in the app. The name without the timestamp (`create_request_log_table`)
is what identifies a migration, so it is unique in the directory. The framework's packages start with
`0001_01_01_000000_<name>.ts`; a file added later carries the date it was written. A file that has shipped is never edited or deleted:
a change of a table is a new file behind the others. Anything in the directory that does not end in `.ts`, such as a `README.md`, and
every sub-directory is passed over.

`module` is required. It is a suggestion: the module the tables go to when the files are copied into the app, which the app can
change. Which module owns a table follows from the module its migration file is in, not from the package. The framework's own
packages name `system`.

The directory must lie in your package: in the directory the app installed, not in a `node_modules` inside it, and not through a
symlink that leads out. The same holds for the files `main`, `types` and `exports` name: discovery stops with [K7](errors.md#server-error-codes) when one lies outside the package, and when `exports` nests deeper than 32 levels. A provider re-exported from another package declares that package's migrations, which the app publishes from
that package. The provider must be exported from the main entry (`.`) of the package the directory lies in: a provider that entry
does not export is not counted for the package, and `publish` says so with a warning. A declaration that lies in no package the app
depends on, such as one in the app's own provider, is passed over. To see what `publish` makes of yours, run
`marmeon publish --check <package>` in an app that depends on it.

A package's code is not trusted, so the static is read strictly, once, and a wrong one fails with
[D21](errors.md#server-error-codes):

- `static migrations` is an object with only `from` and `module`, and two providers do not declare a directory for one package.
- `from` is a `file:` URL without host, query or fragment. Its real path, after following symlinks, lies inside the package, is not the package itself and is a directory.
- `module` is a kebab-case name such as `permissions`, so never a path; it has at most 64 characters and is no Windows device name (`nul`, `com1`, …).
- Every entry is checked by its own real path: a file that is a symlink leading out of the package, or is no regular file, is refused (so is a symlink to a directory whose name ends in `.ts`: it is no file, not passed over). A file whose contents are not valid UTF-8 or have no `export default` is refused too: it cannot be a migration. A hard link to a file outside the package is not detected.
- A `.ts` file is named `<timestamp>_<name>.ts` (so `create_things.ts` and `things.d.ts` are refused), at most 1 MiB, at most 100 in the directory, and the names without timestamp differ. The directory holds at least one.

List the directory in `files` of your `package.json`, so the stubs ship in the tarball; `pnpm pack:check` of this repository does
that for the framework's packages.

### Declaring the files a package publishes

`static publishes` names directories of files `marmeon publish --only=<kind>` copies into an app. In this version only `@marmeon/i18n` publishes
files, its language files, to `lang/marmeon/` (the target is fixed and is not the package's to choose):

```ts
export class I18nServiceProvider implements ServiceProvider {
  static publishes = { lang: new URL('../stubs/lang', import.meta.url) };
}
```

A package that declares `lang` and is not `@marmeon/i18n` (by its own `package.json`) is told so by a warning and publishes nothing. The
declaration is read like the migrations' (assigned to the package that exports the provider and holds the directory), and refused with
[D25](errors.md#server-error-codes) when:

- `static publishes` is no object with only `lang`, or `lang` is no `file:` URL without host, query or fragment.
- Its real path, after following symlinks, lies outside the package, is the package itself or is no directory.
- A file in it is named otherwise than `<language tag>.ts` (`en.ts`, `pt-BR.ts`), is a symlink leading out of the package or no regular file, is larger than 1 MiB, is not UTF-8 or has no `export default`.
- The directory holds more than 100 files, or none.

List the directory in `files` of your `package.json`.
