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
SESSION_SECURE_COOKIE=                  # unset: follows APP_URL — https:// → Secure, http:// → not (E162); true/false decide
SESSION_SAME_SITE=lax                   # lax (default) | strict | none
SESSION_ENCRYPT=false                   # true: the session data is encrypted in its store with APP_KEY (E144) — off by default
SESSION_LOTTERY=2/100                   # chance that a request prunes expired sessions after its response; 0/1 turns it off
CSRF_TRUSTED_ORIGINS=                   # other origins that may post to the app, comma-separated (https://admin.example.com)
```

`SessionConfig` and `CsrfConfig` are the package's config classes. The web app runs `SESSION_DRIVER=database` with
`SESSION_CONNECTION=system` (a SQLite file of its own), its `.env.test` `SESSION_DRIVER=memory`.

**Secure cookies (E162):** `SESSION_SECURE_COOKIE` follows `APP_URL` unless it is set — an app served as `https://…` sends its
cookies with `Secure`, so no browser ever sends them over plain HTTP. It covers **every cookie of the request**, not only the
session's: the provider binds `CookieDefaults` from it, and the kernel gives each request's cookie jar these defaults — the
`XSRF-TOKEN`, the remember-me token, the reset link's cookie, the `cookie` driver's, an app's own `ctx.cookies.set(…)` — unless a
`set` says `secure: false` itself (Laravel's cookie jar defaults). In a protected environment (E139: staging, production, no
`NODE_ENV`) cookies without `Secure` are warned about once at boot: "Cookies are sent without Secure: APP_URL is not https:// —
…" (or "SESSION_SECURE_COOKIE=false — …"). Behind a TLS-terminating proxy nothing else is needed: the decision comes from
`APP_URL`, not from the request's protocol (`TRUSTED_PROXIES`: [@bespokecore/server](../server/README.md#behind-a-proxy-e162)).

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
  the request's session. A flash message is bound to the document (the browser tab) whose request flashed it — the tabSync
  feature names it, `x-bespoke-document` — and another tab's request leaves it waiting; a full page load takes it (E165,
  [tab sync](../http/README.md#tab-sync-w8-step-8)).
- **The tab-sync epoch:** `PageSession.generation()` — a signed-in session's scope and its user's id, `undefined` for a guest — is
  the session's part of `PageObject.epoch` (with the locale; an HMAC keyed from `APP_KEY`): new with every `regenerate()` and
  `invalidate()`, the same for every other write.
- **The `errors` prop:** `ShareErrorsFromSession` shares the flashed validation errors with every page of the `web` group —
  `{}` when there are none, also on partial reloads — what `useForm` shows next to the fields.
- **Sign-in and sign-out:** `regenerate()` gives the session a new id and CSRF token (against session fixation),
  `invalidate()` also drops all data — `@bespokecore/auth` calls them. The old id is destroyed when the request saves it.
- **Requests that must not overlap:** `Route.post(…).block()` runs a route's requests one at a time per session
  ([below](#blocking-routes-block)).
- **Read-only requests:** an island (E52) or a live stream reads the session but never writes it — no save, no cookie, flash
  data stays for the page.

## CSRF protection

`VerifyCsrfToken` (decisions E15, E143 — Laravel 13's model) checks every non-reading request (not `GET`, `HEAD`, `OPTIONS`) of
the `web` group. The first stage that decides wins:

1. **Fetch Metadata.** `Sec-Fetch-Site: same-origin` passes — the browser says a page of this app sent it, and no page can forge
   the header. `same-site` (a subdomain) and `cross-site` are refused with **403** unless their `Origin` is one of
   `CSRF_TRUSTED_ORIGINS`.
2. **Origin** — when the browser sends no Fetch Metadata, or `Sec-Fetch-Site: none` (a navigation the user started — never how a
   form posts): the app's own origin passes, `CSRF_TRUSTED_ORIGINS` too; any other — `null` included (a sandboxed frame, a
   redirect across sites) — is refused with **403**.
3. **The token** — neither header (curl, a script, an old client): the session's token must come along as the `_token` field,
   the `X-CSRF-TOKEN` header or `X-XSRF-TOKEN` (copied from the readable `XSRF-TOKEN` cookie that every kept session's
   response refreshes; compared in constant time). Without it — or without a session — **419** ("Page Expired").

**The app's own origin** is the one a request reaches it at — scheme and host of the request URL, which a trusted proxy's
`X-Forwarded-Proto`/`-Host` set (`TRUSTED_PROXIES`, [@bespokecore/server](../server/README.md)) — and `APP_URL`'s (so a proxy
the app does not trust yet still lets the configured address through). `CSRF_TRUSTED_ORIGINS` lists whole origins — scheme,
host, port, no path (`https://admin.example.com`); a value with a path stops the boot.

**Guests need no session to post** (E143): the login form of a visitor passes by the browser's word — the page hands out no
token, and no session is started just for one ([below](#new-sessions-are-only-kept-when-used)). `page.csrf` and the
`XSRF-TOKEN` cookie come with a session only; a signed-in user's forms still carry the token.

- **Plain HTTP:** browsers send Fetch Metadata only to secure origins (HTTPS, `localhost`, `127.0.0.1`). A staging host over
  plain HTTP falls back to stage 2 — every current browser sends `Origin` with a form post and with `fetch` — then to the token.
- **Clients without a browser** (a script, a mobile app posting to `web` routes) send the token of their session or an
  `Origin` the app accepts; the `api` group (tokens, no session) is not affected.
- **Live validation, uploads, islands:** a live validation is a `POST` like the submit and checked the same way; islands and live
  streams only read.

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
| `redis`    | `<REDIS_PREFIX>session:<key>` ([@bespokecore/redis](../redis/README.md) + `redis`, `SESSION_CONNECTION`) | Redis' own TTL — nothing to prune | apps with login and Redis anyway |
| `memory`   | the process                                                              | on read                                  | tests (gone with the process)                       |
| `cookie`   | an encrypted cookie next to the session id                               | the cookie's `Max-Age`                   | apps **without** login (≈ 2.8 KB of JSON at most)   |

Every server-side store keeps a session under its **key** — the SHA-256 of the session id, never the id
([hashed keys](#hashed-keys-versions-and-encryption-e144-e145)): a file's name, a row's `id`, a Redis key's last part.

### `database`

```sh
bespoke make:session-table   # writes modules/system/migrations/…_create_sessions_table.ts (E96: the table is the app's; --module=<name> for another)
bespoke migrate
```

The table: `id` (primary key — the session's key, the SHA-256 of its id), `user_id` (nullable, indexed — the signed-in user's
id, copied from the session's `_auth_id`; `null` for guests), `payload` (the session as JSON, or encrypted with
`SESSION_ENCRYPT` — a `.secret()` column, so `selectAll()` never returns it), `last_activity` (epoch milliseconds of the last
write, indexed) and `version` (raised by every write, compared by the next — [compare-and-set](#hashed-keys-versions-and-encryption-e144-e145)).
A table made before W8 has no `version` and raw ids: `bespoke make:session-table --upgrade` writes the migration that makes it
anew — every user is signed out once ([UPGRADING](../../UPGRADING.md)); until then the store says so. A session expires `SESSION_LIFETIME` minutes after
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

### Hashed keys, versions and encryption (E144, E145)

**Hashed keys.** The cookie carries the session id (240 random bits, encrypted like every cookie); the store only ever sees its
**key**, `sessionKey(id)` — the SHA-256 of the id, hex (like Rack's `private_id`). Whoever reads the store — a leaked backup, a
replica, a shared Redis — gets keys, and a key sent as the cookie is no session. The once scope and live tokens are derived from
the id as before (`sessionScope(id)`, unchanged), `block()`'s lock is keyed by the key.

**`SESSION_ENCRYPT=true`** encrypts the payload in the store — the file, the `payload` column, the Redis value — with the app's
`Encrypter` (AES-256-GCM, `APP_KEY`; payloads under a key in `APP_PREVIOUS_KEYS` still decrypt, the next write re-encrypts them
with `APP_KEY`), bound to the session's key as authenticated data: a payload copied into another session's place does not open
there. Off by default (like Laravel): the payload holds the CSRF token, the signed-in user's id, their password fingerprint and
flash messages — with hashed keys none of it signs anybody in, but turn it on when the store is shared or backed up where the
data should not be read. The database's `user_id` column stays readable (it is what lists a user's sessions). Turning it on or
off signs everybody out once (the other format does not open — a new session starts). The `cookie` driver's data is encrypted
anyway (it is a cookie); `SESSION_ENCRYPT` changes nothing there.

**Compare-and-set.** Every write is one atomic step of the store that compares the version the request read:

| Store      | How                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `memory`   | synchronous: no `await` between the lookup and the write                                                |
| `file`     | under a per-session guard file (`open(…, 'wx')`): compare the version, then write in place through a handle opened before — a deleted file fails the open (ENOENT) or takes the write with it; new keys are hard-linked into place (never over a session) |
| `database` | `UPDATE sessions … WHERE id = ? AND version = ? AND last_activity > ?` — the row count says whether it wrote; a new key is `INSERT … ON CONFLICT DO NOTHING` |
| `redis`    | a Lua script: compare `v`, write `d` with `v + 1`, renew the TTL                                        |
| `cookie`   | **cannot**: always writes (see below)                                                                   |

A write answers `written`, `conflict` (another request wrote the session since it was read — nothing written) or `gone` (destroyed
or expired — nothing written, and nothing ever brings it back). `Session.save()` turns these into what happens:

- `gone` — a sign-out or sign-in of the same browser overtook this request: the session stays destroyed, no cookie
  ([below](#concurrent-requests-and-signing-out)).
- `conflict` — the session is read again and this request's changes are applied to it: **key by key, what this request changed
  wins** (last write wins), everything else stays as the other request left it; **flash messages are merged by their ids** — none
  is lost, and none a faster request showed comes back (W5b.7: before, 20 of 20 came back). A request that changed nothing stops
  there. After a random moment it writes again — for up to 2 s; every round lets one writer through, so 20 requests of one
  session at once all land. A request that still meets a newer version every time saves nothing and logs a warning
  (`session.abandoned`).

What it does not do: add up. Two requests that read a counter and write it back + 1 both write 2 — the later wins. Routes that
read, decide and write back need [`block()`](#blocking-routes-block).

### Blocking routes (`block()`)

```ts
// The new password's hash and its fingerprint in the session stay a pair — one such request per session at a time:
signedIn.put('/settings/password', UpdatePasswordController).name('auth.password.update').block();
Route.post('/wizard/step', WizardStepController).block(5, 2);   // hold the lock at most 5 s, wait for it at most 2 s
```

`block(lockSeconds = 10, waitSeconds = lockSeconds)` (Laravel's) makes `StartSession` take an atomic lock on the session before it
reads it and free it after saving it — through the app's cache ([@bespokecore/cache](../cache/README.md), locks since E103; without
it the route answers 500 saying so). A second request of the same browser waits; longer than `waitSeconds` → **423 Locked** with
`Retry-After`. A request without a session cookie locks nothing (a new session is nobody else's). The web app and `make:auth`
block the password change and "sign out other devices".

### Your own store

A store implements `SessionStore` (the contract changed in W8 — [UPGRADING](../../UPGRADING.md)):

```ts
interface SessionStore {
  read(key: string): Promise<{ data: string; version: number } | undefined>;
  write(key: string, data: string, options: { expectedVersion: number | undefined; lifetimeSeconds: number; userId?: string | null }): Promise<'written' | 'conflict' | 'gone'>;
  destroy(key: string): Promise<void>;
  gc(lifetimeSeconds: number): Promise<number>;
}
```

`key` is the SHA-256 of the session id (hex, `SESSION_KEY`), `data` opaque text (JSON, or ciphertext) — keep both as they are.
`expectedVersion: undefined` writes a **new** key (version 1) and is a `conflict` when something is stored under it; a number
writes over that version (version + 1) — `conflict` when the stored one differs, `gone` when there is none (destroyed or
expired). Compare and write in **one atomic step**; the shared suite in `src/stores/stores.test.ts` is the contract's test.

### New sessions are only kept when used

A request without a session cookie starts a new session — but it is written (and its cookie sent) only when something is
written into it: data, flash messages or the errors of a failed form, a sign-in — or something bound to it went out: its CSRF
token handed out explicitly (`session.token()`), a live subscription a page signs (`session.persist()` — what a guest's page with
an upload field calls in its controller too: an upload belongs to a session). **A guest's page keeps none** (E143): the login and
registration pages, any public page — no row, no file, no key, no cookie; their forms pass by the browser's word
([CSRF](#csrf-protection)). Nor do health checks, bots, prefetches of protected pages, a post refused by the CSRF check or a JSON
endpoint that never touches the session (`session.persists`). A failed guest form is the first write: its errors start the
session. Sessions that came from the store are always written back.

Without a kept session there is no scope either (`PageSession.scope()` is `undefined`): once props are counted without one, and a
live stream without a session is refused (401).

### Concurrent requests and signing out

A browser often has more than one request of the same session in flight — since deferred props (`defer()`), every
page load is followed by one that loads them. If the user signs out meanwhile, the slower request finishes *after*
the sign-out, with the session as it was when it started: still signed in.

- **Server-side drivers (`file`, `database`, `redis`, `memory`):** `Session.save()` writes a loaded session back over the
  version it loaded (E45, E145): a session another request destroyed meanwhile (a sign-out's `invalidate()`, a sign-in's
  `regenerate()`) is `gone` and stays destroyed — a conflict's re-read finds nothing either — and `StartSession` then sends
  no session cookie: the browser keeps the one the sign-out sent.
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

CSRF verification is off in tests unless `createTestApp(App, { csrf: true })` — then send what a browser sends
(`headers: { 'sec-fetch-site': 'same-origin' }`, or an `Origin`) or the session's `_token`/`X-XSRF-TOKEN` yourself.
