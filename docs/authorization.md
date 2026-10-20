# Authorization

## Introduction

Authentication says who a user is; authorization says what they may do. A policy is a plain class with one method per ability.
Each method takes the user and what the ability is about, and answers whether it is allowed:

```ts title="modules/notes/policies/NotePolicy.ts"
import { deny, type AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

export class NotePolicy {
  view(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || note.shared;
  }

  update(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || deny('Only the author can edit this note.');
  }
}
```

A request asks the policy before its controller runs, with the record that route model binding found:

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { NoteRepository } from '../NoteRepository.ts';

export const UpdateNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(120) }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, ctx.body);
    return this.redirect().route('notes.show', { note: ctx.params.note.id });
  }
}
```

Everything is named and typed. A misspelt ability does not compile, and neither does a route whose parameter is not bound to the
type the policy takes.

## Writing policies

A policy needs no registration and no base class. The container builds it in the request's scope, so its constructor can take
whatever a controller can, such as configuration or a repository:

```ts title="modules/dashboard/policies/DashboardPolicy.ts"
import type { AuthUser } from '@marmeon/auth';
import { DashboardConfig } from '../config.ts';

export class DashboardPolicy {
  readonly #config: DashboardConfig;

  constructor(config: DashboardConfig) {
    this.#config = config;
  }

  viewMembers(user: AuthUser) {
    return this.#config.admins.includes(user.email.toLowerCase());
  }
}
```

An ability takes the user first, then the resources it is about, or none, as `viewMembers` here. It may be `async`, and it
answers with one of these:

| Answer | What the client gets |
| --- | --- |
| `true`, or `allow()` | Allowed. |
| `false` | 403, "This action is unauthorized.", in the request's language. |
| `deny(message)` | 403 with your message. A translation key is translated when the app has it. |
| `denyAsNotFound()` | 404, the same answer as for a record that does not exist. |

`deny()` without a message answers like `false`. Use `denyAsNotFound()` for records whose existence is itself a secret, such as
another tenant's: the client cannot tell a hidden record from a missing one.

A guest is refused before any policy runs, so an ability never sees a missing user. A request that reaches a policy without
`authenticate()` in front of it answers 403, not a redirect to the login.

### Generating a policy

`marmeon make:policy Note --module=notes` writes `modules/notes/policies/NotePolicy.ts` with the abilities `view`, `update` and
`delete`. Each allows the record's owner (`record.user_id === user.id`) and answers everyone else with `denyAsNotFound()`, so
a foreign id looks like a missing one. It starts closed on purpose: widen an ability by hand, never the other way round. The
record type is structural (`{ readonly user_id: … }`); give it your table's `Row<'…'>` once there is one. The command ends by printing the line for the request:

```ts
authorize: can(NotePolicy, 'update', 'note')
```

An existing file is kept unless you pass `--force`.

### Deciding before the ability

A method named `before(user, ability)` runs ahead of every ability of its policy. It returns `true` to allow, `false` to refuse,
or nothing to let the ability decide:

```ts title="modules/notes/policies/NotePolicy.ts"
import type { AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

export class NotePolicy {
  before(user: AuthUser) {
    if (user.email === 'admin@example.com') return true;
  }

  update(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id;
  }
}
```

`before` is a hook, not an ability: `can()` and the gate do not accept it as one.

## Authorizing requests

`authorize` of a request runs after route model binding and before validation. `can()` builds one that asks a policy:

| Form | The resource |
| --- | --- |
| `can(NotePolicy, 'update', 'note')` | The route parameter `note`, after binding. |
| `can(NotePolicy, 'update', (ctx) => ctx.params.note)` | Whatever the function returns from the context. |
| `can(DashboardPolicy, 'viewMembers')` | None, for an ability that takes only the user. |

The compiler checks each form. The ability must exist on the policy, or the call does not compile: `'updte'` is not assignable
to `AbilityOf<NotePolicy>`. The route must bind the parameter to the type the ability takes: a parameter bound to another type, or
not bound at all and so a string, is a compile error where the route registers the controller. An ability that needs a resource
and gets none is an error about the number of arguments, and its note points at the declaration, which says what is missing:

```text
error TS2554: Expected 3 arguments, but got 2.
  Arguments for the rest parameter 'resource' were not provided.
    ...resource: … [resource: `"${K}" needs its resource: a bound route parameter's name, or (ctx) => resource`]
```

A refusal stops the request before the body is validated, so a user who may not edit gets a 403 rather than field errors. The
[controllers](controllers.md#the-order-of-a-request) page shows the whole order.

To decide for a whole group of routes, put the check on the registrar. It runs after the bindings and before the request's own
`authorize`, and every route registered through it has to pass:

```ts
const notes = Route.middleware(authenticate()).bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note'));
```

`everyone` is the check that says yes to anyone its middleware lets through. A route has to say who may call it, and
[the next section](#every-route-decides) shows how.

## Every route decides

A route that does not say who may call it does not start, and neither does an open route that loads records by id. The kernel
checks every route when the app boots, in every environment, production included. `marmeon route:types` and `marmeon build`
check them too and exit with 1.

A route says it in one of two places:

- the `authorize` of its request, which `can()` or a function of your own provides;
- the registrar, with `Route.authorize(check)`, for every route registered through it.

`everyone` is the third word. It is a check that says yes to anyone the route's middleware lets through, so `Route.middleware(authenticate()).authorize(everyone)`
means "any signed-in user". Use it when that is the whole truth: a login page, a list of the user's own notes, a public page. It stands
for a decision you made, and the file shows it. A route that mixes `everyone` with another check keeps the other check: checks add
up, and `everyone` never opens a route further than another check allows.

```ts title="modules/notes/routes.ts"
export default defineRoutes((Route) => {
  // The list and the form ask for the signed-in user's own notes, so every signed-in user may call them.
  const mine = Route.prefix('/notes').middleware(authenticate()).authorize(everyone);
  mine.get('/', ListNotesController).name('notes.index');

  // A note belongs to someone, so its routes ask the policy.
  const note = Route.prefix('/notes').middleware(authenticate()).bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note'));
  note.get('/:note', ShowNoteController).name('notes.show');
});
```

### A request or a registrar

Put the decision on the registrar when the routes share it, and in the request when one route differs. A route passes only when
every check passes: the registrar's checks first, in the order you declared them, then the request's. A group inside a registrar
inherits its checks, and a middleware such as `abilities('notes:read')` is not a decision: it limits which tokens get in, and the
route still says who may call it.

A route that answers with a closure has no request, so it takes its decision from the registrar:

```ts
Route.authorize(everyone).get('/ping', () => 'pong');
```

### Open routes and bindings

A route whose only checks are `everyone` may not bind a record that any key finds. `bind('note', NoteRepository)` on such a route
would hand out every note to whoever guesses an id. The route fails to start unless the binding does one of these:

- the route asks a policy as well: `Route.authorize(can(NotePolicy, 'view', 'note'))`;
- the binding is scoped to its parent: `bind('attachment', AttachmentRepository, { scopedBy: 'note' })`, with the parent checked;
- the records are public by design, on a route that only reads: `bind('user', ProfileDirectory, { public: true })`. A route that
  changes data always needs a real check.

### The report

The report names every route with where it was registered, so a long list is easy to work through:

```text
2 routes do not say who may call them:
  GET  /notes       notes.index  ListNotesController  modules/notes/routes.ts:12
  POST /notes       notes.store  StoreNoteController  modules/notes/routes.ts:13
Say it with one of these:
  - can(Policy, 'ability', 'param') as the request's `authorize`, or on its registrar: Route.authorize(can(…))
  - a check of your own: Route.authorize((ctx) => …) or `authorize` in defineRequest()
  - everyone, last: Route.authorize(everyone) says anyone its middleware lets through may call it — nothing else about it is checked
See docs/authorization.md#every-route-decides.
```

`marmeon route:list` shows the state in its `ACCESS` column: the checks of each route, `everyone` for an open one, `none` for a
route that has no decision. Routes of the framework itself, such as the signed upload and the `/_marmeon/` pages, decide for
themselves and show `framework`.

### Moving an app that has routes without a decision

The quickest way to the behaviour an app had before is one line per route file, visible where you read it:

```ts
export default defineRoutes((Root) => {
  const Route = Root.authorize(everyone);
  // …
});
```

Then answer the reports about open bindings one at a time. Each is a record that anyone who reaches the route can read.

### What the check does not see

A check is only as good as what it can see. The router cannot tell a check that always returns `true` from a real one, a custom
binder that ignores the `scope` it is given, or a handler that loads `ctx.params.id` itself instead of binding it. A policy check
on one record also says nothing about a different record the route binds without `scopedBy`. And `{ public: true }` on a binder whose
records are not public silences the check: the router takes your word for it. Review these by hand: the rule makes
sure somebody decided, not that they decided right.

A refusal is a 403. Where ids must not be enumerable, a policy answers `denyAsNotFound()`, which makes a foreign record and a
missing one look alike.

## The gate

`Gate` asks policies anywhere in the request: in a controller, or in a service the controller calls. Inject it:

```ts title="modules/user-profile/controllers/ShowUserProfileController.ts"
import { Gate, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import type { Profile } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  readonly #gate: Gate;

  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }

  async handle(ctx: HttpContext<Authenticated, { user: Profile }>) {
    const { email, ...profile } = ctx.params.user;
    return this.view('user-profile/Show', {
      profile,
      email: (await this.#gate.allows(ProfilePolicy, 'viewEmail', profile)) ? email : null,
    });
  }
}
```

The e-mail address leaves the server only for its owner. The controller decides what a page gets, so a prop the user may not see
is never sent.

| Method | Returns |
| --- | --- |
| `allows(Policy, ability, ...resources)` | Whether the user may. |
| `denies(Policy, ability, ...resources)` | The opposite. |
| `authorize(Policy, ability, ...resources)` | Nothing, or throws `AuthorizationError`: 403 with the policy's reason, or 404. |
| `inspect(Policy, ability, ...resources)` | The policy's full answer, a `PolicyResponse` with `allowed`, `status` and `message`. |

## Abilities for the page

A page shows a button only when its action is allowed. The gate hands the page one boolean per ability you name, never a policy's
reason:

```ts title="modules/user-profile/controllers/ShowUserProfileController.ts"
import { Gate, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import type { Profile } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  readonly #gate: Gate;

  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }

  handle(ctx: HttpContext<Authenticated, { user: Profile }>) {
    const { email, links, ...user } = ctx.params.user;
    return this.view('user-profile/Show', {
      abilities: this.#gate.abilities(user, ProfilePolicy, ['update']),
      profile: async () => ({ ...user, links: await this.#gate.withAbilities(links, ProfileLinkPolicy, ['delete']) }),
    });
  }
}
```

The view reads `abilities.update`, and each link carries `link.can.delete`:

```tsx title="modules/user-profile/views/Show.tsx"
import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';

export default function Show({ abilities, profile }: PageProps<ShowUserProfileController>) {
  return (
    <main>
      <h1>{profile.name}</h1>
      {abilities.update && <Link route="user-profile.edit" params={{ user: profile.id }}>Edit</Link>}
      <ul>
        {profile.links.map((link) => (
          <li key={link.id}>
            {link.label} {link.can.delete && <Link route="user-profile.links.remove" params={{ user: profile.id, link: link.id }} layer>Remove</Link>}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

| Method | What the page gets |
| --- | --- |
| `abilities(resource, Policy, names)` | `{ update: boolean }` for one resource. |
| `abilities(Policy, names)` | The same for abilities that take no resource. |
| `withAbilities(rows, Policy, names)` | Each row with `can: { delete: boolean }`. |

- **Explicit.** Only the abilities you name are asked, and the names are checked against the policy when you compile. A name that
  is not an ability, or one that needs a resource you did not pass, is a compile error with the reason, such as
  `'updte' is not an ability of this policy — it has update, viewEmail`.
- **Lazy.** As a page prop, a projection runs only when the response includes that prop. A partial reload that asks for other
  props never runs the policy. To refresh abilities together with their data, project them inside that prop, as `profile` does
  above.
- **Counted.** `withAbilities()` calls the policy once per row and ability: 50 rows and one ability are 50 calls. That is cheap
  for a comparison, and a query per row for a policy that queries. Load what the policy needs with the rows. `before()` runs once
  per ability for the whole list.

Abilities are a hint for the interface. The server checks again on every request that acts, with `can()` or the gate.

## Policies and API tokens

On a route behind `authenticate('api')`, the token guard tells the request's gate whose token it is. `can()` and the gate then ask
their policies about the token's user, as they ask about the session's user on a page. The token's abilities are checked on top:
`abilities(...)` refuses a token that lacks one before any policy runs, and a policy allows only what the user may do anyway.

```ts title="modules/notes/api-routes.ts"
import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { NoteRepository } from './NoteRepository.ts';
import { UpdateNoteApiController } from './controllers/UpdateNoteApiController.ts';

export default defineRoutes((Route) => {
  const api = Route.middleware(authenticate('api'));
  api.middleware(abilities('notes:write')).bind('note', NoteRepository).put('/notes/:note', UpdateNoteApiController).name('api.notes.update');
});
```

```ts title="modules/notes/controllers/UpdateNoteApiController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { NoteRepository } from '../NoteRepository.ts';

export const UpdateNoteApiRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(120) }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateNoteApiController extends Controller {
  static request = UpdateNoteApiRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteApiRequest>) {
    await this.#notes.update(ctx.params.note.id, ctx.body);
    return { id: ctx.params.note.id, title: ctx.body.title };
  }
}
```

The author's token with `notes:write` updates the note. Another user's token gets the policy's 403, and a token without
`notes:write` gets 403 before the policy is asked. An ability only says what kind of action a token may do, never on whose
record: the policy says that.

> [!WARNING]
> A route behind `authenticate('api')` without `abilities()` lets every token of the user act with all of the user's rights: the
> policies, a `before()` that lets an admin do anything included. A token the user created to read notes then deletes them too.
> Give every API route that acts an `abilities()` of its own.

## Testing

A test signs in as a user with `actingAs()` and asserts the status:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteRepository } from './NoteRepository.ts';

it('lets only the author edit a note', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const [ada, alan] = await app.factory(UserFactory).count(2).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada!.id, title: 'Draft', body: '' });
  await app.actingAs(alan!).expectingJson().put(`/notes/${note.id}`, { json: { title: 'Mine now' } }).assertForbidden();
});
```

A policy is a plain class, so a unit test can also build it with `new` and call its methods. The [HTTP
tests](http-tests.md#assertions) page covers the assertions.
