# Service Providers

## Introduction

A service provider sets up the services of a module or a package when the app starts. It binds them into the
[service container](container.md), and it runs the code that needs every other service in place, such as adding a middleware or
defining a rate limit. Each framework package brings its own provider, and a module adds one when it has something to set up.

```ts title="modules/notes/NotesServiceProvider.ts"
import { Limit, RateLimiter } from '@marmeon/cache';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { NoteRepository } from './NoteRepository.ts';
import { DatabaseNoteSearch } from './DatabaseNoteSearch.ts';
import { NoteSearch } from './NoteSearch.ts';

export class NotesServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(NoteRepository);
    container.singleton(NoteSearch, DatabaseNoteSearch);
  }

  boot(app: Application): void {
    // Sharing a note: 30 a minute per signed-in user.
    app.container.make(RateLimiter).for('notes-share', (ctx) => Limit.perMinute(30).by(String((ctx as { user?: { id: number } }).user?.id ?? ctx.ip)));
  }
}
```

The module lists its provider in its definition:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import { NotesServiceProvider } from './NotesServiceProvider.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  providers: [NotesServiceProvider],
  routes,
});
```

## Register and boot

A provider has up to three methods, and the app calls them in two phases:

| Method | When | What belongs there |
| --- | --- | --- |
| `register(container)` | First, for every provider. | Bindings only: `singleton()`, `scoped()`, `bind()`, `instance()`. |
| `boot(app)` | Once every provider has registered. | Code that resolves services: middleware, rate limits, event hooks, checks. |
| `shutdown(app)` | When the app stops. | Releasing what the provider holds: pools, file handles, subscriptions. |

Every provider registers before any provider boots. So `boot()` may resolve any service, also one that a later provider binds.
`register()` must not resolve anything: another provider may not have bound it yet.

`register()` is also the only phase that `marmeon build` runs. The build loads the app to write the route types, registers every
provider and boots none, without `.env` and without a key. A configuration that needs a secret is not available there, and
reading it throws an error that names the variables. Read configuration in `boot()`, or in the services themselves. The
[configuration](configuration.md#configuration-and-the-build) page explains why.

The app builds each provider through the container, and every method is optional. A class listed as a provider without any of
them, and without `static config` or `static health` from the list below, stops the start:

```text
NotesServiceProvider is listed as a service provider but has no register(), boot(), shutdown(), static config or static health.
```

## The order

The providers run in this order:

1. The providers of the installed packages, each after the packages it depends on. [Discovery](modules.md#discovery) finds them.
2. The app's own, from `providers` in `bootstrap/app.ts`.
3. Each module's, in the order of `modules`.

`register()` runs for all of them in this order, then `boot()` in the same order. `shutdown()` runs in reverse order, so a
provider stops before the providers it was booted after, and still has everything it depends on.

## Shutting down

`app.shutdown()` runs every provider's `shutdown()` once. The server calls it after the drain on `SIGTERM`, the `marmeon` command
after a command, and a test when its app is disposed. Each provider gets its turn even if an earlier one fails, and the errors
are thrown together at the end.

```ts title="modules/search/SearchServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { SearchIndex } from './SearchIndex.ts';

export class SearchServiceProvider implements ServiceProvider {
  readonly #index = new SearchIndex();

  register(container: Container): void {
    container.instance(SearchIndex, this.#index);
  }

  async boot(app: Application): Promise<void> {
    await this.#index.open(app.root);
  }

  async shutdown(): Promise<void> {
    await this.#index.close();
  }
}
```

An app in the build phase never booted, so no provider's `shutdown()` runs there.

## What a provider brings besides code

A provider class can carry three static lists. The app reads them before any provider registers:

| Static | What it is |
| --- | --- |
| `static config = [NotesConfig]` | The [config definitions](configuration.md#defining-configuration) the provider needs. They are checked with the app's own. |
| `static health = [SearchIndexReady]` | Checks for `/up/ready`. See [health checks](health.md). |
| `static solutions = defineSolutions([…])` | Solutions for the provider's errors, shown on the development error page. See [error handling](errors.md#solutions). |

A package uses these lists, because it has no module definition of its own. In an app, a module lists its configuration and its
health checks in its definition instead.

## Providers of packages

A package registers its provider through discovery: the `"marmeon"` field of its `package.json` names the provider class, and
every app that installs the package registers it. The [package development](package-development.md) page explains how to write
one.

## Testing

A test app runs every provider, like the real app. `override` replaces a binding after every provider registered and before any
boots, so even a provider's `boot()` sees the replacement:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NoteSearch } from './NoteSearch.ts';

it('uses the fake search', async () => {
  await using app = await createTestApp(application, {
    override: (c) => c.instance(NoteSearch, { search: async () => [] }),
  });
  // …
});
```

The [service container](container.md#testing) page has more on replacing services.
