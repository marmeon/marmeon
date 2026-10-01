# @bespokecore/session

Sessions for BespokeCore apps: a scoped, injectable `Session` (no `ctx.session`), loaded by the `StartSession`
middleware before the route and saved after it, flash data, CSRF protection (`VerifyCsrfToken`) and the shared
`errors` prop. Keys are typed through `interface SessionData` (declaration merging).

## Session drivers

Chosen with `SESSION_DRIVER` (see `SessionConfig`):

| Driver   | Where the data lives                              | Use it for                                          |
| -------- | ------------------------------------------------- | --------------------------------------------------- |
| `file`   | one JSON file per session (`SESSION_FILES`), default | apps with login — survives restarts, single server |
| `memory` | the process                                       | tests (gone with the process)                       |
| `cookie` | an encrypted cookie next to the session id        | apps **without** login (≈ 2.8 KB of JSON at most)   |

`database` and `redis` drivers are planned (Waves 3/6), as further implementations of the `SessionStore` contract.

### Concurrent requests and signing out

A browser often has more than one request of the same session in flight — since deferred props (`defer()`), every
page load is followed by one that loads them. If the user signs out meanwhile, the slower request finishes *after*
the sign-out, with the session as it was when it started: still signed in.

- **Server-side drivers (`file`, `memory`):** `Session.save()` does not write back a session that another request
  destroyed meanwhile (a sign-out's `invalidate()`, a sign-in's `regenerate()`), and `StartSession` then sends no
  session cookie — the browser keeps the one the sign-out sent. The check reads the store once more before writing;
  it is not atomic (an atomic `writeIfExists` comes with the `database`/`redis` drivers).
- **`cookie` driver:** cannot be protected. The whole session travels in the cookie, so the slower response brings
  the signed-in cookie back and the sign-out is undone. With `@bespokecore/auth` registered, the app logs a warning
  at boot. **Use `file` (or, later, `database`/`redis`) for apps with login.**
