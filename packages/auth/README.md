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

- [Authentication](https://marmeon.com/docs/authentication)
- [Authorization](https://marmeon.com/docs/authorization)
- [Email Verification](https://marmeon.com/docs/verification)
- [Password Reset](https://marmeon.com/docs/passwords)
- [API Tokens](https://marmeon.com/docs/api-tokens)
- [Hashing](https://marmeon.com/docs/hashing)
- [Starter Kit](https://marmeon.com/docs/starter-kit)
- [HTTP Tests: sessions and signing in](https://marmeon.com/docs/http-tests#sessions-and-signing-in)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
