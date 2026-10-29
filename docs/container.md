# Service Container

## Introduction

The service container builds your classes and hands them what they need. A controller, a middleware, a listener or a job asks
for its dependencies in its constructor, and the container passes them in. You write no list of dependencies and no
decorator: the list is derived from the constructor's types.

```ts title="modules/notes/controllers/ShowNoteController.ts"
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';
import { NotesConfig } from '../config.ts';

export class ShowNoteController extends Controller {
  readonly #notes: NoteRepository;
  readonly #config: NotesConfig;

  constructor(notes: NoteRepository, config: NotesConfig) {
    super();
    this.#notes = notes;
    this.#config = config;
  }

  async handle(ctx: HttpContext<{}, { note: string }>) {
    const note = await this.#notes.find(Number(ctx.params.note));
    return this.view('notes/Show', { note, sharing: this.#config.sharing });
  }
}
```

Most classes need nothing more. A class the container has no binding for is built on the spot, with its own dependencies
resolved the same way. You bind something only to share one instance, to choose an implementation for an interface, or to build
a service in a special way.

## Constructor injection

A constructor parameter is injected when its type exists while the app runs: a class, or a token. Classes from your app and from
the framework's packages work the same way.

Import such a type as a value. `import type { NoteRepository }` disappears when the app runs, so the container would not know
what to pass. Building the class then fails, and the error says why:

```text
[marmeon:K3] [ShowNoteController] needs 2 constructor argument(s) but has no injection list. Cannot inject modules/notes/controllers/ShowNoteController.ts:9 — ShowNoteController, parameter "notes: NoteRepository": "NoteRepository" is imported with "import type", so it does not exist at runtime. Import its token as a value: import { NoteRepository } from '…'.
```

A parameter of type `string`, `number` or a union cannot be injected either. Put such values into a [config
definition](configuration.md#defining-configuration) and inject that, or wrap them in a token.

### Where the lists come from

The lists are made by a loader that reads your classes as Node loads them. `marmeon dev`, `marmeon start` and every `marmeon`
command install it, and the `marmeon()` Vite plugin does the same for the tests and for server rendering. The framework's
packages carry their lists already.

`marmeon build` writes the lists of the app's classes in advance. In production the start applies them without reading the code
again, so it stays fast. A file that changed since the build is read as in development, and the app logs once that the build is
out of date:

```text
Build artifacts are stale (1 file: modules/users/ShowUserController.ts): they changed since marmeon build, so their injection lists were derived at start, with oxc-parser — run marmeon build again.
```

### Default values are never injected

A parameter with a default value ends the list. The container never injects it: JavaScript's default always applies, also when
a provider or a test binds something else. When such a parameter has an injectable type, the container warns once per class,
in development:

```text
[warn] Injection: PruneTokensJob (modules/auth/jobs/PruneTokensJob.ts:5): the parameter "clock: Clock = new SystemClock()" is defaulted, so the container never injects Clock — its default is always used, also when a provider or a test binds another Clock. Remove the default to have it injected, or write `static inject = [...]` to make the choice explicit.
```

The same holds for an optional parameter, `clock?: Clock`. Remove the default to have the service injected.

### A list of your own

A class that declares `static inject` keeps its own list, and the loader leaves it alone. The compiler checks the list against
the constructor, so a missing, extra or swapped entry is a compile error:

```ts title="modules/notes/NotePrinter.ts"
import { Clock } from '@marmeon/core';
import { NotesConfig } from './config.ts';

export class NotePrinter {
  static inject = [Clock, NotesConfig] as const;

  readonly #clock: Clock;
  readonly #config: NotesConfig;

  constructor(clock: Clock, config: NotesConfig) {
    this.#clock = clock;
    this.#config = config;
  }

  header(): string {
    return `${new Date(this.#clock.now()).toISOString()} · ${this.#config.perPage} per page`;
  }
}
```

You rarely need it. It makes the choice explicit where a parameter has a default on purpose.

## Binding services

A [service provider](providers.md#register-and-boot) binds services in its `register()` method:

```ts title="modules/notes/NotesServiceProvider.ts"
import type { Container, ServiceProvider } from '@marmeon/core';
import { NoteRepository } from './NoteRepository.ts';
import { NoteSearch } from './NoteSearch.ts';
import { DatabaseNoteSearch } from './DatabaseNoteSearch.ts';
import { NoteDraft } from './NoteDraft.ts';

export class NotesServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(NoteRepository);
    container.singleton(NoteSearch, DatabaseNoteSearch);
    container.scoped(NoteDraft);
  }
}
```

The container knows four lifetimes:

| Method | Lifetime |
| --- | --- |
| `container.bind(key, target)` | A new instance on every resolution. |
| `container.singleton(key, target?)` | One instance for the whole process, built the first time it is asked for. |
| `container.scoped(key, target?)` | One instance per scope: per request, per job attempt, per command. |
| `container.instance(key, value)` | A value you built yourself. |

`target` is a class or a factory function. A factory gets a resolver for the services it needs:

```ts
container.singleton(NoteSearch, (c) => new DatabaseNoteSearch(c.make(NoteRepository), { limit: 50 }));
```

A factory may keep the resolver and call it later, for example to build a service when it is first used. That call continues the build
running at that moment; when none runs, it starts a new chain, so a service that needs the factory's own key is no circular dependency.
A cycle that closes while a build runs is still reported. An async factory's `make` continues its own chain until its promise settles.

Binding a key again replaces the earlier binding, and a singleton built from it already. `container.make(key)` resolves a service,
`container.has(key)` tells whether a key is bound, and `container.keys()` lists every key. Prefer constructor injection to
`make()`: the dependencies then show in the constructor, and tests replace them without knowing where they are used.

### Interfaces and tokens

An interface has no value when the app runs, so it cannot be a key by itself. Declare a token of the same name next to it. One
import then brings both, the type and the key:

```ts title="modules/notes/NoteSearch.ts"
import { token } from '@marmeon/core';

export interface NoteSearch {
  search(term: string): Promise<number[]>;
}
export const NoteSearch = token<NoteSearch>('NoteSearch');
```

A class that asks for `search: NoteSearch` gets whatever the provider bound to the token. The framework's own contracts work the
same way: `Logger`, `Clock` and `Mailer` are tokens.

## Scopes

Each request runs in a scope of its own, a child container. The kernel builds the request's controller and middleware from it,
the queue worker each job attempt's classes, and `marmeon` each command. A scoped service lives as long as its scope, so two
requests never share one.

This is why a singleton must not depend on a scoped service. A singleton is built once, in the root container. If it captured
the first request's session, every later request would see it. The container refuses it:

```text
[marmeon:K2] [NoteDraft] is scoped and can only be resolved inside a scope (e.g. a request) (needed by NoteSearch). A singleton must not depend on a scoped service.
```

A service that needs something of the request becomes scoped too. The rule keeps request data in the request: there is no
global state that a later request could read.

## The container's errors

A `ContainerError` names what failed, why, and who asked for it. Its `reason` is one of five:

| `reason` | Means | The fix |
| --- | --- | --- |
| `unbound` | A token has no binding. | Bind it in a provider's `register()`, or install the package that does. |
| `scoped` | A scoped service was resolved outside a scope, or by a singleton. | Inject it into a controller, middleware, listener or job instead. A singleton that needs it becomes scoped. |
| `no-injection-list` | A class has constructor parameters but no list. The error says what the loader could not inject. | Inject classes and tokens only. Values come from a config definition. |
| `circular` | `A` needs `B`, and `B` needs `A`. | Move what both need into a third class. |
| `undefined-dependency` | An entry of a class's list is `undefined` (or `make()` is given `undefined`): the class it names was not defined yet when this one was. The error names the class and the parameter. Usually two modules import each other. | Let one module read what the other [exposes](queries.md#module-boundaries) instead of importing its class. |

Each message starts with its [code](errors.md#server-error-codes): `unbound` is K1, `scoped` K2, `no-injection-list` K3, `circular` K4 and `undefined-dependency` K16.

The path in the message shows the chain, outermost first: `(needed by ShowNoteController → NoteSearch)`. On the development
error page each reason comes with its solution.

## Testing

A test replaces a binding before the app boots, so even singletons see the replacement:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NoteSearch } from './NoteSearch.ts';

it('searches through the fake', async () => {
  await using app = await createTestApp(application, {
    override: (c) => c.instance(NoteSearch, { search: async () => [1, 2] }),
  });
  // …
});
```

`app.container` resolves services in a test. The [fakes](fakes.md) page shows the fakes the framework brings for mail, the queue,
storage and more.
