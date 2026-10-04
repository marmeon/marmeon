# @bespokecore/session

Sessions for BespokeCore apps: a scoped, injectable `Session` (no `ctx.session`), loaded by the `StartSession`
middleware before the route and saved after it, flash data, CSRF protection (`VerifyCsrfToken`) and the shared
`errors` prop. Keys are typed through `interface SessionData` (declaration merging).

```ts
// modules/locale/controllers/UpdateLocaleController.ts — constructor(…, session: Session, …)
this.#session.put('locale', locale);                  // typed: SessionData declares `locale: string` (@bespokecore/i18n)
const locale = this.#session.get('locale');           // string | undefined
```

`bespoke discover` registers its `SessionServiceProvider` through the `"bespoke"` field of its package.json: the scoped
`Session`, the store of `SESSION_DRIVER`, and three middleware of the `web` group — `StartSession`, `VerifyCsrfToken` and
`ShareErrorsFromSession` — plus `make:session-table` and `session:prune` (when `@bespokecore/cli` is installed). The `database`
and `redis` drivers need their packages — optional peers; a missing one fails the start with what to install
(`SessionSetupError`). The session cookie's value is redacted wherever requests are recorded (E125).

## Configuration

```sh
SESSION_DRIVER=file                     # file (default) | database | redis | memory | cookie
SESSION_CONNECTION=default              # database/redis: which database or Redis connection (default: default)
SESSION_LIFETIME=120                    # minutes of inactivity until the session expires (default 120)
SESSION_COOKIE=bespoke_session          # the cookie's name (default)
SESSION_FILES=storage/framework/sessions   # file: where sessions live, relative to the app root (default)
SESSION_SECURE_COOKIE=false             # true: the cookie only over HTTPS — turn it on in production (default false)
SESSION_SAME_SITE=lax                   # lax (default) | strict | none
SESSION_LOTTERY=2/100                   # chance that a request prunes expired sessions after its response; 0/1 turns it off
CSRF_TRUSTED_ORIGINS=                   # other origins that may post to the app, comma-separated (https://admin.example.com)
```

`SessionConfig` and `CsrfConfig` are the package's config classes. The web app runs `SESSION_DRIVER=database` with
`SESSION_CONNECTION=system` (a SQLite file of its own), its `.env.test` `SESSION_DRIVER=memory`.

## The session

- **Data:** `get(key)`, `put(key, value)`, `pull(key)`, `has(key)`, `forget(...keys)`, `all()` (without the framework's `_…`
  keys), `flush()`. Values must survive `JSON.stringify` — a `Date` comes back as a string. Declared keys are checked:

  ```ts
  declare module '@bespokecore/session' {
    interface SessionData { cart: number[] }
  }
  ```

- **Flash data:** `flash(key, value)` — for this and the next request; `keep(...keys)`, `reflash()`. `flashInput(input)` and
  `old(key?)` refill a form after a failed submit (`redirect().withInput()`). A redirect's `.with(…)` and `.flash(key, data)`
  (flash messages, E60 — kept until a response the user is shown takes them, not aged by prefetches or islands) write into
  the request's session.
- **The `errors` prop:** `ShareErrorsFromSession` shares the flashed validation errors with every page of the `web` group —
  `{}` when there are none, also on partial reloads — what `useForm` shows next to the fields.
- **Sign-in and sign-out:** `regenerate()` gives the session a new id and CSRF token (against session fixation),
  `invalidate()` also drops all data — `@bespokecore/auth` calls them. The old id is destroyed when the request saves it.
- **Read-only requests:** an island (E52) or a live stream reads the session but never writes it — no save, no cookie, flash
  data stays for the page.

## CSRF protection

`VerifyCsrfToken` (decision E15) refuses every non-reading request (not `GET`, `HEAD`, `OPTIONS`) of the `web` group with
**419** ("Page Expired") unless:

1. the browser does not say it is cross-site (`Sec-Fetch-Site: cross-site`) and its `Origin` is the app's own host or one of
   `CSRF_TRUSTED_ORIGINS` (a request without `Origin` — curl, old clients — is decided by the token alone), and
2. it carries the session's token — as the `_token` field, the `X-CSRF-TOKEN` header, or `X-XSRF-TOKEN`, copied from the
   readable `XSRF-TOKEN` cookie that every kept session's response refreshes (compared in constant time).

The client core sends `X-XSRF-TOKEN` by itself; forms without JavaScript post `page.csrf` as `_token` (E64). Paths that
cannot carry a token — webhooks — are listed by their module (`*` matches any characters):

```ts
defineModule({ name: 'billing', routes, csrfExcept: ['/webhooks/*'] });
```

`container.make(CsrfProtection).except('/webhooks/*')` does the same from a provider. `@bespokecore/testing` turns the check off
unless a test asks for it (`createTestApp(App, { csrf: true })`), like Laravel.

## Session drivers

Chosen with `SESSION_DRIVER` (see `SessionConfig`):

| Driver     | Where the data lives                                                     | Expiry                                   | Use it for                                          |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------- |
| `file`     | one file per session (`SESSION_FILES`) — the default                     | lottery / `session:prune` (by mtime)     | apps with login on one server                       |
| `database` | a row in `sessions` (`bespoke make:session-table`, `SESSION_CONNECTION`) | lottery / `session:prune` (`last_activity`) | apps with login, several processes or servers    |
| `redis`    | `<REDIS_PREFIX>session:<id>` ([@bespokecore/redis](../redis/README.md) + `redis`, `SESSION_CONNECTION`) | Redis' own TTL — nothing to prune | apps with login and Redis anyway |
| `memory`   | the process                                                              | on read                                  | tests (gone with the process)                       |
| `cookie`   | an encrypted cookie next to the session id                               | the cookie's `Max-Age`                   | apps **without** login (≈ 2.8 KB of JSON at most)   |

### `database`

```sh
bespoke make:session-table   # writes modules/system/migrations/…_create_sessions_table.ts (E96: the table is the app's; --module=<name> for another)
bespoke migrate
```

The table: `id` (primary key), `user_id` (nullable, indexed — the signed-in user's id, copied from the session's
`_auth_id`; `null` for guests), `payload` (the session as JSON — a `.secret()` column, so `selectAll()` never returns it)
and `last_activity` (epoch milliseconds of the last write, indexed). A session expires `SESSION_LIFETIME` minutes after
its last activity. Expired rows are deleted by the lottery (`SESSION_LOTTERY`, default 2 in 100 requests, after the
response) or by `bespoke session:prune` — from cron (then set `SESSION_LOTTERY=0/1`) or from the app's scheduler
(`s.command('session:prune').everyFifteenMinutes()`, [@bespokecore/scheduler](../scheduler/README.md)): then requests draw no
lottery at all.

**Its own connection, never the app's transactions (E108).** The store writes through `connections.infrastructure()`
([infrastructure connections](../database/README.md#infrastructure-connections-e108)): a session written while a transaction
is open — an in-process request inside `connections.transaction()`, a test — is not rolled back with it.

| Database | What the store gets | Inside an open app transaction |
| -------- | ------------------- | ------------------------------ |
| Postgres | a small pool of its own to the same database (`DB_INFRA_POOL_MAX`, default 4) — nothing to configure | works; survives the rollback |
| SQLite with a file of its own (`SESSION_CONNECTION=system`, a `defineConnection('system', …)` for e.g. `storage/system.sqlite`) | that file | works; survives the rollback |
| SQLite, the app's own file (`SESSION_CONNECTION=default`) | the file's one connection, shared | throws `InfrastructureTransactionError` (configure a file of its own, or use Redis) — never a silent join. Outside transactions (the normal case: a request saves its session after the controller) it works as before |

The migration `make:session-table` writes follows the connection: `connection: sessionTableConnection` puts the table on
`SESSION_CONNECTION` (with the database driver; otherwise on `default`), and `bespoke migrate` creates it there.

**The payload is not encrypted** in a file, a row or Redis (like Laravel without `SESSION_ENCRYPT`): it holds the CSRF token, the
signed-in user's id and their password fingerprint. Protect the store like the database; encryption as an option is a
candidate for later.

### What `writeIfExists` guarantees

Every store implements `SessionStore.writeIfExists(id, data, lifetime) → boolean`: it writes a session back **only while
it still exists, in one atomic step of the store** — there is no moment between "it is there" and "write it" in which
another request's `destroy()` could slip:

| Store      | How                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `memory`   | synchronous: no `await` between the lookup and the write                                                |
| `file`     | `open(path, 'r+')` and an in-place write — a deleted file fails the open (ENOENT) or takes the write with it |
| `database` | `UPDATE sessions … WHERE id = ? AND last_activity > ?` — the row count says whether it wrote            |
| `redis`    | `SET <key> <payload> XX EX <ttl>` — `XX` only replaces a key that exists                                |
| `cookie`   | **cannot**: always writes (see below)                                                                   |

It returns `false` — and writes nothing — for an id that was destroyed, has expired or was never written. A new session,
and a session regenerated at sign-in/sign-out (a new id), go through `write`.

What it does **not** guarantee: two requests of the same session that both write it back — the later one wins with its
copy (*last write wins*). A flash message one request took can come back when a slower request that loaded it, but did not
take it (a prefetch), saves afterwards. That needs versions (compare-and-set), not existence.

### New sessions are only kept when used

A request without a session cookie starts a new session — but it is written (and its cookie sent) only when it is worth
keeping: it holds data or flash messages, or its CSRF token was handed out (every page does, for its forms;
`session.token()`). Health checks, bots, prefetches of protected pages, a post refused for its CSRF token, a JSON
endpoint that never touches the session: no row, no file, no cookie (`session.persists`). Sessions that came from the
store are always written back.

### Concurrent requests and signing out

A browser often has more than one request of the same session in flight — since deferred props (`defer()`), every
page load is followed by one that loads them. If the user signs out meanwhile, the slower request finishes *after*
the sign-out, with the session as it was when it started: still signed in.

- **Server-side drivers (`file`, `database`, `redis`, `memory`):** `Session.save()` writes a loaded session back with
  `writeIfExists` (E45): a session another request destroyed meanwhile (a sign-out's `invalidate()`, a sign-in's
  `regenerate()`) stays destroyed, and `StartSession` then sends no session cookie — the browser keeps the one the
  sign-out sent.
- **`cookie` driver:** cannot be protected. The whole session travels in the cookie, so the slower response brings
  the signed-in cookie back and the sign-out is undone. With `@bespokecore/auth` registered, the app logs a warning
  at boot (E46). **Use `file`, `database` or `redis` for apps with login.**

### When a session ends

Signing in (`regenerate()`) or out (`invalidate()`) gives the session a new id and destroys the old one when the request saves
it. Whoever must know — the live package closes every stream of the old session, in every process (W6.10,
[@bespokecore/live](../live/README.md)) — listens through `SessionEndings` (one per app):
`container.make(SessionEndings).listen((scope) => …)` hears the old session's **scope** (`sessionScope(id)`, a hash of its id —
never the id, which is a secret; the same value `PageSession.scope()` hands out for once props and live tokens). A listener
that fails does not stop the others.

## Testing

With `@bespokecore/testing` (and a server-side driver — `SESSION_DRIVER=memory` in `.env.test`; the cookie driver has no
session helpers):

```ts
await app.withSession({ cart: [42] }).get('/checkout');   // a session holding this data — to sign someone in: actingAs(user)
await app.post('/locale', { form: { locale: 'de' } }).assertSessionHas('locale', 'de');   // also assertSessionMissing, session()
```

A flash message is asserted on the page that delivers it: `(await app.navigating().get('/login')).assertFlash('toast', { … })`.

CSRF verification is off in tests unless `createTestApp(App, { csrf: true })` — then send `_token` or `X-XSRF-TOKEN` yourself.
