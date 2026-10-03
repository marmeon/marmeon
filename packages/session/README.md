# @bespokecore/session

Sessions for BespokeCore apps: a scoped, injectable `Session` (no `ctx.session`), loaded by the `StartSession`
middleware before the route and saved after it, flash data, CSRF protection (`VerifyCsrfToken`) and the shared
`errors` prop. Keys are typed through `interface SessionData` (declaration merging).

## Session drivers

Chosen with `SESSION_DRIVER` (see `SessionConfig`):

| Driver     | Where the data lives                                                     | Expiry                                   | Use it for                                          |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------- |
| `file`     | one file per session (`SESSION_FILES`) — the default                     | lottery / `session:prune` (by mtime)     | apps with login on one server                       |
| `database` | a row in `sessions` (`bespoke make:session-table`, `SESSION_CONNECTION`) | lottery / `session:prune` (`last_activity`) | apps with login, several processes or servers    |
| `redis`    | `<REDIS_PREFIX>session:<id>` (`@bespokecore/redis` + `redis`, `SESSION_CONNECTION`) | Redis' own TTL — nothing to prune | apps with login and Redis anyway                    |
| `memory`   | the process                                                              | on read                                  | tests (gone with the process)                       |
| `cookie`   | an encrypted cookie next to the session id                               | the cookie's `Max-Age`                   | apps **without** login (≈ 2.8 KB of JSON at most)   |

### `database`

```sh
bespoke make:session-table   # writes modules/system/migrations/…_create_sessions_table.ts (E96: the table is the app's)
bespoke migrate
```

The table: `id` (primary key), `user_id` (nullable, indexed — the signed-in user's id, copied from the session's
`_auth_id`; `null` for guests), `payload` (the session as JSON — a `.secret()` column, so `selectAll()` never returns it)
and `last_activity` (epoch milliseconds of the last write, indexed). A session expires `SESSION_LIFETIME` minutes after
its last activity. Expired rows are deleted by the lottery (`SESSION_LOTTERY`, default 2 in 100 requests, after the
response) or by `bespoke session:prune` — from cron (then set `SESSION_LOTTERY=0/1`) or from the app's scheduler
(`s.command('session:prune').everyFifteenMinutes()`, `@bespokecore/scheduler`): then requests draw no lottery at all.

**Its own connection, never the app's transactions (E108).** The store writes through `connections.infrastructure()`
(see `packages/database/README.md`): a session written while a transaction is open — an in-process request inside
`connections.transaction()`, a test — is not rolled back with it.

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
it. Whoever must know — the live package closes every stream of the old session, in every process (W6.10) — listens through
`SessionEndings` (one per app): `container.make(SessionEndings).listen((scope) => …)` hears the old session's **scope**
(`sessionScope(id)`, a hash of its id — never the id, which is a secret; the same value `PageSession.scope()` hands out for
once props and live tokens). A listener that fails does not stop the others.
