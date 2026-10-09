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

> [!WARNING]
> Route model binding finds a record by its id, whoever owns it. Without `authorize`, the note of any user is one id away. Give
> every route that binds a record a policy, or bind it within its owner, as the
> [routing](routing.md#scoped-bindings) page shows.

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

The gate asks the session for its user. The routes of the `api` group have no session, so `can()` and the gate find no user there
and refuse every request with 403. Authorize an API route with the token's [abilities](api-tokens.md#abilities), and compare
`ctx.user` with the record in the controller:

```ts title="modules/notes/controllers/ShowNoteApiController.ts"
import type { Authenticated, WithToken } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { abort, Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteApiController extends Controller {
  handle(ctx: HttpContext<Authenticated & WithToken, { note: Row<'notes'> }>) {
    if (ctx.params.note.user_id !== ctx.user.id) abort(404);
    return { id: ctx.params.note.id, title: ctx.params.note.title };
  }
}
```

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
