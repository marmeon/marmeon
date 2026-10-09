# @marmeon/auth

Authentication and authorization for Marmeon apps: the session guard, "remember me", password hashing and resets, the
confirmation of an address, API tokens, policies and the `make:auth` generator.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it and writes the starter kit's `auth` module — the sign-in,
registration and password pages, the app's own code from then on. An app made with `--minimal` adds the module later:

```sh
pnpm marmeon make:auth
pnpm marmeon migrate
```

## Protecting a route

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).get('/notes', ListNotesController).name('notes.index');
});
```

`authenticate()` lets only signed-in users through, and the controller finds the user in `ctx.user`. `verified()` lets in only
accounts whose address is confirmed.

## Documentation

- [Authentication](https://github.com/marmeon/marmeon/blob/main/docs/authentication.md)
- [Authorization](https://github.com/marmeon/marmeon/blob/main/docs/authorization.md)
- [Email Verification](https://github.com/marmeon/marmeon/blob/main/docs/verification.md)
- [Password Reset](https://github.com/marmeon/marmeon/blob/main/docs/passwords.md)
- [API Tokens](https://github.com/marmeon/marmeon/blob/main/docs/api-tokens.md)
- [Hashing](https://github.com/marmeon/marmeon/blob/main/docs/hashing.md)
- [Starter Kit](https://github.com/marmeon/marmeon/blob/main/docs/starter-kit.md)
- [HTTP Tests: sessions and signing in](https://github.com/marmeon/marmeon/blob/main/docs/http-tests.md#sessions-and-signing-in)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
