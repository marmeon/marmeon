# API Tokens

## Introduction

A script, a command-line tool or a mobile app cannot fill in a login form and keep a session cookie. It sends a token instead: a
personal access token that a user creates on a page of your app and copies into the client. Routes for such clients go into a
module's `apiRoutes` file, which the app serves under `/api` in the `api` group: no session, no cookies and no CSRF check, since
every request proves itself with its token.

```ts title="modules/notes/api-routes.ts"
import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesApiController } from './controllers/ListNotesApiController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate('api')).middleware(abilities('notes:read')).get('/notes', ListNotesApiController).name('api.notes.index');
});
```

The module lists the file as `apiRoutes` in its definition, and the route answers `GET /api/notes`:

```sh
curl -H "Authorization: Bearer marmeon_12|…" https://example.com/api/notes
```

The [starter kit](starter-kit.md) has a page where users create and revoke their tokens, and `GET /api/user`, which answers who a
token belongs to.

## Creating tokens

`AccessTokenStore` creates a token for a user and returns its plain text once:

```ts title="modules/auth/controllers/CreateAccessTokenController.ts"
import { AccessTokenStore, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { abilityDescriptions, TOKEN_ABILITIES, type TokenAbility } from '../abilities.ts';

const abilityNames = [...TOKEN_ABILITIES] as [TokenAbility, ...TokenAbility[]];

export const CreateAccessTokenRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(60),
    abilities: r.union([r.in(abilityNames), r.array(r.in(abilityNames)).required()]).transform((value) => [value].flat()),
  }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

export class CreateAccessTokenController extends Controller {
  static request = CreateAccessTokenRequest;

  readonly #tokens: AccessTokenStore;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof CreateAccessTokenRequest>) {
    const { plainText } = await this.#tokens.create(ctx.user.id, ctx.body.name, { abilities: ctx.body.abilities, expiresIn: '90d' });
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: abilityDescriptions(this.#translator),
      plainText: plainText as string | null,
    });
  }
}
```

The form sends one ability or several, one value per ticked checkbox, so the schema takes both and makes a list.

`create(userId, name, { abilities, expiresIn })` returns `{ plainText, token }`. The table keeps only a SHA-256 hash of the token's
secret, so the plain text exists only in this one response. Without `abilities` a token may do everything, `['*']`. Without
`expiresIn` it lives until it is revoked; the starter kit gives every token 90 days. `expiresIn` takes seconds, or `'30m'`,
`'12h'`, `'90d'`.

The controller renders the page with the plain text instead of redirecting. A redirect would have to carry the token through the
session as flash data, and so write it into the session store.

> [!WARNING]
> A token is as good as a session: whoever holds it acts as its user until it expires or is revoked, after a password reset too
> unless [`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`](#revoking-every-token-with-a-new-password). The starter kit puts the whole
> tokens page behind a confirmed address and `confirmedPassword()`: a stolen session cannot mint a token without the password,
> and an account registered with somebody else's address cannot mint one that outlives the owner's takeover. Keep both on pages
> of your own that create tokens. With `AUTH_PRIVATE_REGISTRATION=false` the module's `ConfirmedAddress` lets everyone through,
> so put `verified()` on the token routes in its place.

## The token format

A token reads `marmeon_12|` followed by 40 random letters and digits and a checksum of 8 hexadecimal characters. Each part has a
purpose:

- **The prefix**, `AUTH_TOKEN_PREFIX`, lets secret scanners recognize a leaked token, for example in a public repository. It may
  hold lower-case letters, digits and `_`, at most 16 of them.
- **The number** is the token's row, so the lookup is one query by id.
- **The checksum**, a CRC32 over everything before it, lets a typo fail before any query. `parseAccessToken(plainText, prefix)`
  checks the format and the checksum without the database.

40 random characters give 62⁴⁰ possibilities, about 2²³⁸. That needs no slow hash: a fast SHA-256 stays out of reach of guessing,
and a slow hash per API request would hand anyone who sends invalid tokens a way to load the server.

## Authenticating requests

`authenticate('api')` reads `Authorization: Bearer <token>`, and adds `ctx.user` and `ctx.token`:

```ts title="modules/notes/controllers/ListNotesApiController.ts"
import type { Authenticated, WithToken } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class ListNotesApiController extends Controller {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated & WithToken>) {
    return { data: await this.#notes.forUser(ctx.user.id) };
  }
}
```

A missing, malformed, unknown, revoked or expired token, and one whose user no longer exists, get the same answer:
`401 {"message":"Unauthenticated."}` with `WWW-Authenticate: Bearer`. A session cookie counts for nothing here. The secret is
compared in constant time. `ctx.token` holds the token without its secret: `id`, `userId`, `name`, `abilities`, `lastUsedAt`,
`expiresAt` and `createdAt`. The token's last use is written at most once a minute, not on every request.

`can()` and the gate ask their policies about the token's user here, and the token's abilities are checked on top. The
[authorization](authorization.md#policies-and-api-tokens) page shows both on one route.

## Abilities

A token carries a list of abilities, strings your app chooses, such as `notes:read`. `abilities(...names)` after
`authenticate('api')` lets a request through only when its token grants every name:

```ts title="modules/notes/api-routes.ts"
import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesApiController } from './controllers/ListNotesApiController.ts';
import { StoreNoteApiController } from './controllers/StoreNoteApiController.ts';

export default defineRoutes((Route) => {
  const api = Route.middleware(authenticate('api'));
  api.middleware(abilities('notes:read')).get('/notes', ListNotesApiController).name('api.notes.index');
  api.middleware(abilities('notes:write')).post('/notes', StoreNoteApiController).name('api.notes.store');
});
```

A token without one of them gets `403 {"message":"This token may not: notes:write."}`. A token with `*` may do everything.
`tokenCan(ctx.token, 'notes:write')` asks the same in code.

The starter kit's tokens page offers the abilities listed in `TOKEN_ABILITIES` of `modules/auth/abilities.ts`, `users:read` at
first. Add yours there, with a description in the module's language file, so users can grant them:

```ts title="modules/auth/abilities.ts"
export const TOKEN_ABILITIES = ['users:read', 'notes:read', 'notes:write'] as const;
```

## Listing and revoking tokens

| Method | What it does |
| --- | --- |
| `list(userId)` | The user's tokens, without their secrets. |
| `revoke(userId, id)` | Deletes one token of the user. `false` when the user has no token with this id. |
| `find(plainText)` | The token for a plain text, or `undefined`. |

`revoke()` takes the user's id as well, so a user can never revoke another user's token by its number. The starter kit answers 404
for such a request, the same as for a token that does not exist.

A token stays valid until it expires or is revoked. A user who thinks a token leaked revokes it on the tokens page. When an account
is deleted, its tokens go with it. "Sign out other devices" leaves the tokens as they are.

### Revoking every token with a new password

By default a new password and a password reset leave the user's tokens as they are. With `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`
both revoke every token of the user:

```sh title=".env"
AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true
```

`updatePassword()` and the reset delete the tokens first and then store the new hash, in one transaction of the default
connection. A failed delete stores no hash, so a new password never stands next to an old token. When storing the hash fails,
the transaction gives the tokens back, as long as your token store uses the default connection, as `DatabaseAccessTokens` does. The log notes how many tokens went, and `PasswordChanged` and
`PasswordReset` carry the number as `revokedTokens`. Your scripts and integrations then need a new token after every password
change.

Turn it on when a reset is how a stolen account comes back to its owner: whoever had the password may have created a token with
it. With open registration, `AUTH_PRIVATE_REGISTRATION=false`, turn it on: an account registered with somebody else's address can
create a token before the owner takes the account over with a reset, and the reset then ends that token too.

## Pruning tokens

An expired token stops working at once, but stays in the table, and on the tokens page, until it is pruned:

```sh
pnpm marmeon auth:prune-tokens
pnpm marmeon auth:prune-tokens --hours=48
```

The command deletes the password reset tokens older than `AUTH_RESET_EXPIRE`, the expired remember-me tokens and the API tokens
that expired more than `--hours` hours ago, `0` by default. Valid tokens stay. It reports how many of each it deleted. The starter
kit runs it every night at 03:10 on one server:

```ts title="modules/auth/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
});
```

## A store of your own

Tokens live in the `personal_access_tokens` table by default, through `DatabaseAccessTokens`. To keep them elsewhere, bind your own
`AccessTokenStore` in a provider. It implements `create`, `find`, `touch`, `list`, `revoke`, `revokeAll` and `prune`, and keeps a
hash of each secret, never the secret. `revokeAll(userId)` deletes every token of the user and returns how many; a new password
calls it inside its transaction, so a store on the database joins it.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_TOKEN_PREFIX` | `marmeon_` | The prefix of every token. Lower-case letters, digits and `_`, at most 16. Changing it invalidates every token made before. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a new password and a password reset revoke every token of the user. Only `true` and `false` start; an empty one counts as unset. |

## Testing

`actingAs(user, { guard: 'api' })` sends a real token with the request:

```ts title="modules/notes/api.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('lists the notes for a token that may read them', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada, { guard: 'api', abilities: ['notes:read'] }).get('/api/notes').assertOk();
  await app.actingAs(ada, { guard: 'api', abilities: [] }).get('/api/notes').assertForbidden();
});
```

The [HTTP tests](http-tests.md#assertions) page covers the other assertions.
