# Marmeon

Marmeon is a full-stack framework for TypeScript on Node.js: an app is a set of modules whose routes, controllers and React
pages are typed from end to end, and the server renders each page before the browser takes over. A new app comes with a
database, sessions, validation, mail, queues and a scheduler already wired together, and further packages add file storage,
Redis, live updates and more.

```ts
// modules/notes/controllers/ShowNoteController.ts — one endpoint, one class
export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {   // `note` bound by the route: a missing one is a 404
    if (ctx.params.note.user_id !== ctx.user.id) return this.redirect().route('notes.index');
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

```tsx
// modules/notes/views/Show.tsx — the props are the controller's, typed end to end
export default function Show({ note }: PageProps<ShowNoteController>) {
  return (
    <main>
      <h1>{note.title}</h1>
      <Link route="notes.index">All notes</Link>
    </main>
  );
}
```

Status: 0.x on npm — a minor version may still break ([release policy](docs/releases.md#before-10)). MIT licence (`LICENSE`, copyright [BespokeCode](https://bespokecode.de)). Node 26.10 or newer, pnpm 12.

## Principles

1. **Typed end to end** — from the database column through the controller, validation and route names to the form error in the
   React component.
2. **No global state** — no facades, no singletons holding request data: one application, a scope per request or job.
3. **TypeScript runs natively on Node** — no transpile step, no decorators: constructor injection works from generated lists.
4. **Modules first** — a module brings its routes, providers, migrations, views and tests; installed packages register
   themselves.
5. **One endpoint, one class** — controllers, jobs, listeners, commands, mails and policies are classes with `handle()`.
6. **Batteries included, behind contracts** — the services that talk to the outside world have several drivers, and mail, the
   queue, notifications, storage, events, live updates and the schedule have a fake for tests.
7. **Secure by default** — protections fail closed outside development, page data never lands in the browser's storage, and
   signed-in pages are never cached.

## Installation

Node 26.10 or newer and pnpm 12, or npm with `--npm`:

```sh
pnpm create marmeon my-app        # the starter kit: sign-in and registration, a home page, devtools, oxlint, Vitest
cd my-app
pnpm dev                          # the server with Vite, a queue worker and the scheduler on http://localhost:3000
```

`--minimal` makes a blank app instead, and `--docker` adds the files to run it in containers. The
[installation](docs/installation.md) page walks through every step, and the
[first day after a release](docs/installation.md#the-first-day-after-a-release) explains why pnpm may hold a new version back.

## Documentation

The documentation lives in [`docs/`](docs/) — and, once it is online, as a Marmeon app of its own (`apps/website`). Start with
[Installation](docs/installation.md), [Directory Structure](docs/structure.md) and [Routing](docs/routing.md); the
[Packages](docs/packages.md) page says what each package brings. The [Security](docs/security.md) page sums up what an app
protects by itself and what it leaves to you, and the [Upgrade Guide](UPGRADING.md) lists every change from one version to the
next.

## Versions and deprecations

Every `@marmeon/*` package, the CLI `marmeon` and `create-marmeon` are released together and always have the same version —
upgrade them together. In 0.x a minor version may break, and every break has an entry in [UPGRADING.md](UPGRADING.md); a patch
never breaks. From 1.0 on, breaking changes come only in a major version, after a deprecation. The
[release policy](docs/releases.md) has the details.

## Contributing and security

Contributions are welcome under the Developer Certificate of Origin — every commit signed off (`git commit -s`). How to set up,
check and release, and how the repository is laid out: [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately,
never in a public issue: [SECURITY.md](SECURITY.md).

Marmeon is MIT licensed ([LICENSE](LICENSE)).
