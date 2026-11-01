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

An existing file is kept unless you pass `--force`. [`marmeon make:resource`](starter-kit.md#adding-a-resource) writes this policy with the
table's `Row<'…'>`, together with the routes and requests that use it.

### Deciding before the ability

A method named `before(user, ability)` runs ahead of every ability of its policy. It returns `true` to allow, `false` to refuse,
or nothing to let the ability decide:

```ts title="modules/notes/policies/NotePolicy.ts"
import type { AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

export class NotePolicy {
  before(user: AuthUser) {
    if (user.is_admin) return true;
  }

  update(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id;
  }
}
```

`before` is a hook, not an ability: `can()` and the gate do not accept it as one. Decide by a column that holds the role, as `is_admin` does here. Never decide by an address: a user can change it.

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

A controller under such a registrar names the parameters it binds as the second argument of `ContextOf`, because the request's own
`authorize` does not bring them:

```ts
handle(ctx: ContextOf<typeof ShowNoteRequest, { note: Row<'notes'> }>) {
  return this.view('notes/Show', { title: ctx.params.note.title });
}
```

The compiler checks them where the controller is registered: a route whose registrar binds no `note`, or binds it to another type,
is an error.

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

Routes a package attaches to a page with `attach()` carry the page's checks and its request's `authorize` too, so a page's
exports and actions answer nobody the page refuses (a table's [endpoints](tables.md#the-controller-and-the-routes) are such routes). See [routes under a page](routing.md#routes-under-a-page).

### Open routes and bindings

A route whose only checks are `everyone` may not bind a record that any key finds. `bind('note', NoteRepository)` on such a route
would hand out every note to whoever guesses an id. The route fails to start unless the binding does one of these:

- the route asks a policy as well: `Route.authorize(can(NotePolicy, 'view', 'note'))`;
- the binding is scoped to its parent: `bind('attachment', AttachmentRepository, { scopedBy: 'note' })`, with the parent checked;
- the records are public by design, on a route that only reads: `bind('user', ProfileDirectory, { public: true })`. A route that
  changes data always needs a real check.
- the route's credential is a token in its path, and a check of your own decides: `Route.authorize(describeAccess((ctx) => …, 'invitation link'))`
  (see [a link that is used once](urls.md#a-link-that-is-used-once)). The alternative is to pass the token unbound and look its row up in the controller
  ([Results](errors.md#results)).
- the route changes data under a parent that is public, and a check of your own finds the parent open (next section).

`marmeon route:list` shows each route that binds a record as public, as `everyone (public: user)` in the `ACCESS` column and
as `publicBindings` in `--json` — review that list, not each file.

#### A public write under a public parent

A page that is open to everyone often has a form that changes data below it. The `GET` reads the event and says its records
are public. The `POST` that registers a guest may not lean on that, because `{ public: true }` is never accepted on a route that
changes data. Name the check that decides whether the event takes registrations, and limit how fast it is tried:

```ts title="modules/events/routes.ts"
import { throttle } from '@marmeon/cache';
import { abort, defineRoutes, describeAccess, everyone } from '@marmeon/http';
import { RegisterController } from './controllers/RegisterController.ts';
import { ShowEventController } from './controllers/ShowEventController.ts';
import { PublicEvents } from './PublicEvents.ts';
import { isOpen } from './isOpen.ts';

export default defineRoutes((Route) => {
  const events = Route.prefix('/events');

  events.authorize(everyone).bind('event', PublicEvents, { public: true }).get('/:event', ShowEventController);

  events
    .middleware(throttle('registrations'))
    .bind('event', PublicEvents)
    .authorize(
      describeAccess((ctx) => {
        if (!isOpen(ctx.params.event)) abort(404);
        return true;
      }, 'open event'),
    )
    .post('/:event/register', RegisterController);
});
```

`marmeon route:list` shows `open event` in the `ACCESS` column of the `POST`. `describeAccess()` only names the check; the
function is all that guards the `POST`, so it reads the event's state, and a closed or unknown event gets the same 404.

A check written apart from its route sees only `HttpContext`; write it inside `.authorize()` after the `.bind()` it reads, or annotate `ctx`.

A limit without `.by()` is one counter for the whole app, so one script could close registration for everyone. Count it per
client in a provider's `boot()`, as in [defining limiters](rate-limiting.md#defining-limiters):
`limiter.for('registrations', (ctx) => Limit.perMinute(5).by(clientKey(ctx.ip)))`.

### Records nobody owns

`make:policy` and `make:resource` start from a record with an owner. A record for everybody, such as the rooms of a
booking app that every visitor may look at, has no `user_id`, so the generated policy has nothing to compare. Open the reads
with `everyone` and `{ public: true }`, and keep a real check on everything that changes data:

```ts title="modules/rooms/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListRoomsController } from './controllers/ListRoomsController.ts';
import { ShowRoomController } from './controllers/ShowRoomController.ts';
import { UpdateRoomController } from './controllers/UpdateRoomController.ts';
import { RoomPolicy } from './policies/RoomPolicy.ts';
import { RoomRepository } from './RoomRepository.ts';

export default defineRoutes((Route) => {
  const rooms = Route.prefix('/rooms').name('rooms.');

  // Anyone may read, also a visitor who is not signed in; `.middleware(authenticate())` before `authorize(everyone)` would limit it to signed-in users.
  // The list asks for no record, and the binding says its records are public.
  const open = rooms.authorize(everyone);
  open.get('/', ListRoomsController).name('index');
  open.bind('room', RoomRepository, { public: true }).get('/:room', ShowRoomController).name('show');

  // Only a signed-in user whom RoomPolicy lets in may change a room.
  rooms.middleware(authenticate()).bind('room', RoomRepository).authorize(can(RoomPolicy, 'update', 'room')).put('/:room', UpdateRoomController).name('update');
});
```

`RoomPolicy` decides without an owner: write the ability to compare the user with whatever makes someone allowed to manage
rooms in your app, and leave it closed until you do. `public` excuses reads only ([a binding everyone may use](routing.md#a-binding-everyone-may-use)), so a route that changes a shared
record always names a check. `marmeon route:list` shows `rooms.show` as `everyone (public: room)` and the list as `everyone`.

### A tenant in the path

Marmeon knows no roles, tenants or memberships: they are your app's tables and your app's words. This section shows one way to
write them, for an app with workspaces whose members have a role in each workspace. The names (`workspaces`, `memberships`,
`owner`, `editor`, `viewer`) are the example's; take the shape, not the names.

The workspace is in the path, and the records below it are looked up within it:

```ts title="modules/workspaces/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ShowProjectController } from './controllers/ShowProjectController.ts';
import { UpdateProjectController } from './controllers/UpdateProjectController.ts';
import { ProjectPolicy } from './policies/ProjectPolicy.ts';
import { ProjectRepository } from './ProjectRepository.ts';
import { WorkspacePolicy } from './policies/WorkspacePolicy.ts';
import { WorkspaceRepository } from './WorkspaceRepository.ts';

export default defineRoutes((Route) => {
  // The workspace is bound and checked first; every route below inherits both.
  const workspace = Route.prefix('/workspaces/:workspace')
    .middleware(authenticate())
    .bind('workspace', WorkspaceRepository)
    .authorize(can(WorkspacePolicy, 'view', 'workspace'));

  // `scopedBy` looks a project up within the workspace of the path: a project of another workspace answers 404.
  const project = workspace.bind('project', ProjectRepository, { scopedBy: 'workspace' });

  project.authorize(can(ProjectPolicy, 'view', 'project')).get('/projects/:project', ShowProjectController).name('projects.show');
  project.authorize(can(ProjectPolicy, 'update', 'project')).put('/projects/:project', UpdateProjectController).name('projects.update');
});
```

The binding and the check do different jobs. `bind()` finds the record, and `scopedBy` makes sure it belongs to the workspace in
the URL. The policy then decides by the signed-in user's role in the record's own workspace, not in the URL's: the policy stays
right on a route that has no workspace in its path, and on a call from the [gate](#the-gate). A route that binds a
record anyone can reach, and has no check beside `everyone`, does not start ([open routes and bindings](#open-routes-and-bindings)).

A controller under this registrar names what it binds, as [above](#authorizing-requests):

```ts
handle(ctx: ContextOf<typeof ShowProjectRequest, { workspace: Row<'workspaces'>; project: Row<'projects'> }>) {
  return this.view('projects/Show', { title: ctx.params.project.title, workspace: ctx.params.workspace.name });
}
```

To share what a layout shows about the workspace, use an [`afterAuthorize` hook](routing.md#after-the-checks) on the same
registrar: it runs only for a request the checks let through, so a stranger's 404 carries nothing about the workspace.

#### A policy that decides by role

The policy answers by the user's role in the workspace of the record. The roles and what each may do are a table in the
policy's file, which is where a reviewer looks for them:

```ts title="modules/workspaces/policies/ProjectPolicy.ts"
import { denyAsNotFound, type AuthUser } from '@marmeon/auth';
import { WorkspaceAccess } from '../WorkspaceAccess.ts';

const abilities = {
  owner: ['view', 'update', 'delete'],
  editor: ['view', 'update'],
  viewer: ['view'],
} as const satisfies Record<string, readonly string[]>;

type Ability = (typeof abilities)[keyof typeof abilities][number];

/** The record's tenant is the only workspace that counts; `workspace_id` is the column that holds it. */
interface InWorkspace {
  readonly workspace_id?: number | null;
}

export class ProjectPolicy {
  readonly #access: WorkspaceAccess;

  constructor(access: WorkspaceAccess) {
    this.#access = access;
  }

  view(user: AuthUser, project: InWorkspace) {
    return this.#decide(user, project, 'view');
  }

  update(user: AuthUser, project: InWorkspace) {
    return this.#decide(user, project, 'update');
  }

  delete(user: AuthUser, project: InWorkspace) {
    return this.#decide(user, project, 'delete');
  }

  async #decide(user: AuthUser, project: InWorkspace, ability: Ability) {
    // A record without a workspace has no one who may act on it, and one that nobody can see looks like a missing record.
    if (typeof project.workspace_id !== 'number') return denyAsNotFound();

    const role = await this.#access.roleIn(user.id, project.workspace_id);
    // No membership, or a role this table does not know (one a migration or an old release stored): closed, and a 404.
    if (role === undefined || !Object.hasOwn(abilities, role)) return denyAsNotFound();

    const allowed: readonly string[] = abilities[role as keyof typeof abilities];
    // A role without `view` cannot know the record exists, even if someone edited the table: 404. A role that may view but not
    // do this knows the record exists: a plain 403.
    if (!allowed.includes('view')) return denyAsNotFound();
    return allowed.includes(ability);
  }
}
```

It fails closed. Each of these answers 404, the same as for a record that does not exist, so a foreign id tells nothing:

- the user has no membership in the record's workspace, which includes a record of another workspace;
- the stored role is not in the table;
- the record has no `workspace_id`.

A member whose role lacks `view` gets a 404 as well, so a role edited out of the table cannot reveal records. A member who may view but lacks the ability gets a 403. A guest never reaches the policy: the gate refuses them first. The role comes
only from the signed-in user's memberships, looked up for the workspace of the record: never from the request, not from a
header, a query string or a hidden field.

#### A lookup once per request

The policy asks `WorkspaceAccess` for the role. It loads the user's memberships in one query and answers every later question of
the request from them, keyed by the user's id so one user's memberships can never answer for another:

```ts title="modules/workspaces/WorkspaceAccess.ts"
import type { AuthUser } from '@marmeon/auth';
import { MembershipRepository } from './MembershipRepository.ts';

export class WorkspaceAccess {
  readonly #memberships: MembershipRepository;
  readonly #roles = new Map<AuthUser['id'], Promise<ReadonlyMap<number, string>>>();

  constructor(memberships: MembershipRepository) {
    this.#memberships = memberships;
  }

  /** The user's role in a workspace, or `undefined` for someone who is no member. */
  async roleIn(userId: AuthUser['id'], workspaceId: number): Promise<string | undefined> {
    let roles = this.#roles.get(userId);
    if (roles === undefined) {
      roles = this.#load(userId);
      this.#roles.set(userId, roles);
    }
    return (await roles).get(workspaceId);
  }

  async #load(userId: AuthUser['id']): Promise<ReadonlyMap<number, string>> {
    const rows = await this.#memberships.query().select(['workspace_id', 'role']).where('user_id', '=', userId).execute();
    return new Map(rows.map((row) => [row.workspace_id, row.role] as const));
  }
}
```

Register it as scoped, in a [service provider](providers.md#register-and-boot):

```ts title="modules/workspaces/WorkspacesServiceProvider.ts"
import type { Container, ServiceProvider } from '@marmeon/core';
import { WorkspaceAccess } from './WorkspaceAccess.ts';

export class WorkspacesServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.scoped(WorkspaceAccess);
  }
}
```

> [!WARNING]
> Never `container.singleton(WorkspaceAccess)`. A singleton lives as long as the process, and so would every user's memberships:
> a member who was removed keeps their role until the app restarts. `scoped()` gives each request its own instance, and a job
> or a command its own for each attempt or run.

A policy is built for each check, so state that should last the whole request lives in a scoped service, as `WorkspaceAccess`
does here. Left unregistered, the class is built for each check as well. That is correct, and costs one query per ability: leave
it so until a page that asks many abilities shows the cost. The [container](container.md#binding-services) page lists the
lifetimes.

#### A binder that knows the user

A binder can keep a workspace from a stranger even before the policy runs. A binder that reads the signed-in user says so with
[`RouteBindingContext<Authenticated>`](routing.md#your-own-binder), and `bind()` then accepts it only behind `authenticate()`.
The container builds it for each request, so it shares the scoped `WorkspaceAccess`:

```ts title="modules/workspaces/MemberWorkspaces.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import type { RouteBinder, RouteBindingContext } from '@marmeon/http';
import { WorkspaceAccess } from './WorkspaceAccess.ts';
import { WorkspaceRepository } from './WorkspaceRepository.ts';

/** `/workspaces/:workspace` — a workspace the signed-in user is a member of, or a 404. */
export class MemberWorkspaces implements RouteBinder<Row<'workspaces'>> {
  readonly #access: WorkspaceAccess;
  readonly #workspaces: WorkspaceRepository;

  constructor(access: WorkspaceAccess, workspaces: WorkspaceRepository) {
    this.#access = access;
    this.#workspaces = workspaces;
  }

  async resolveRouteBinding(key: string, { ctx }: RouteBindingContext<Authenticated>) {
    const workspace = await this.#workspaces.findByRouteKey(key);
    return workspace !== undefined && (await this.#access.roleIn(ctx.user.id, workspace.id)) !== undefined ? workspace : undefined;
  }
}
```

Bind it in place of the repository, `.bind('workspace', MemberWorkspaces)`. The binder is a convenience, not the decision: the
policy still checks the role of each record, and `can(WorkspacePolicy, …)` stays on the registrar. `WorkspacePolicy` has the
shape of `ProjectPolicy`, asking `roleIn()` for the workspace's own id.

### A token in the path is the credential

An invitation or a ticket link has a token in its path, and the token is the whole credential: whoever holds it may use it, signed
in as anyone or not. No policy can say more about it than the row does. The route says so, and the lookup by the token's hash
decides:

```ts title="modules/invitations/routes.ts"
import { authenticate } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { credentialPage, defineRoutes, describeAccess, everyone } from '@marmeon/http';
import { AcceptInvitationController } from './controllers/AcceptInvitationController.ts';
import { ShowInvitationController } from './controllers/ShowInvitationController.ts';
import { InvitationRepository } from './InvitationRepository.ts';

export default defineRoutes((Route) => {
  const invitations = Route.prefix('/invitations').middleware(credentialPage()).middleware(throttle('invitations'));

  // Anyone with the link may look at it. InvitationRepository finds the row by the token's hash (see below) and answers 404 for any other value.
  invitations.authorize(everyone).bind('invitation', InvitationRepository, { public: true }).get('/:invitation', ShowInvitationController);

  // Accepting changes data, so it names its credential, and only a signed-in user may accept.
  invitations
    .middleware(authenticate())
    .bind('invitation', InvitationRepository)
    .authorize(describeAccess((ctx) => ctx.params.invitation !== undefined, 'invitation link'))
    .post('/:invitation', AcceptInvitationController);
});
```

- **The binder is the check, so it must look the row up by the token.** `InvitationRepository` overrides `resolveRouteBinding()`
  with `hashLinkToken()`, `secretEquals()` and `used_at is null`, as `TicketRepository` does in
  [a link that is used once](urls.md#a-link-that-is-used-once). The default binding by id on a public GET would open every
  invitation. `{ public: true }` is allowed only on a route that reads. The route that changes data needs a
  check of its own, and `describeAccess(check, 'invitation link')`, written inside `.authorize()` after the `.bind()` it reads, is that check: it tells `marmeon route:list` that the
  credential is the link (the `ACCESS` column shows `invitation link`), and the start does not refuse the route
  ([open routes and bindings](#open-routes-and-bindings)). It decides nothing more than "the binder found a row", so look
  the row up with the token's hash, and answer a missing, used and revoked token with the same 404.
- **Put `credentialPage()` on every route that carries the token.** It keeps the page out of shared caches, search indexes and
  a `Referer` ([a link that is a credential](security.md#a-link-that-is-a-credential)). The `throttle('invitations')` after it
  limits how fast tokens can be tried; the app defines that limiter in a provider's `boot()`
  ([defining limiters](rate-limiting.md#defining-limiters)), or the start stops.
- **Who may then do what is a different question.** The invitation lets a user in; the role the new member gets comes from the
  invitation's row, written when an owner issued it, never from the request that accepts it. Accepting redeems the row and inserts the membership in one
  transaction; a lost redeem answers 404. From then on the policy above decides. See [a link that is used once](urls.md#a-link-that-is-used-once) for the token and its hash.

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

A projection is awaitable, so code outside a page prop can read it: `const { update } = await this.#gate.abilities(note, NotePolicy, ['update'])`.
It runs the policy once, however often it is awaited.

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
