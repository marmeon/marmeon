# Security

What a BespokeCore app protects by itself, what it leaves to you, and where each part is explained. The defaults are chosen to
be safe when nobody changes them; where a protection costs something (a dependency, a migration, a cache), it is a switch, and
this page says which way it points. Found a vulnerability? Report it privately — [SECURITY.md](../SECURITY.md).

## The environment decides — and fails closed

Development tools — the error page with code and queries, the devtools, `Server-Timing`, mail previews, Vite's dev server — run
**only** with `NODE_ENV=development`. Protections — JSON logs, `migrate` asking for `--force`, boot warnings, no lab pages — apply to
**every other value but `test`** (the test runner's: neither tools nor protections) **and to none**: a staging box, a typo or a
server where `NODE_ENV` was forgotten is protected like production (E139,
[the environment](../packages/core/README.md#the-environment-node_env)). Where the process sets no `NODE_ENV`, the app's `.env`
may (E170) — a new app's says `development`. Set `NODE_ENV` in the server's environment (the image does; it wins over `.env`) and
never deploy a developer's `.env`: a `bespoke start`, `queue:work` or `schedule:work` that runs as development because of one
warns loudly, and its start line says `development (from .env)`.

## Requests from other sites (CSRF)

Every request of the `web` group that changes something is checked in stages
([CSRF protection](../packages/session/README.md#csrf-protection)): the browser's `Sec-Fetch-Site: same-origin` passes, a request
from another site is refused with 403; without Fetch Metadata the `Origin` decides; only a client that sends neither needs the
session's token. Guests get no session just for a token. List other origins you trust in `CSRF_TRUSTED_ORIGINS` (whole origins);
webhooks that cannot carry a token go into a module's `csrfExcept`.

- Browsers send Fetch Metadata to secure origins only — over plain HTTP the check falls back to `Origin`, then to the token. Serve
  production over HTTPS.
- The `api` group has no session and no CSRF check: it authenticates every request by its token
  ([API tokens](../packages/auth/README.md#api-tokens-e27)).

## Sessions and cookies

- **Every cookie is `Secure` when `APP_URL` is `https://`** — `SESSION_SECURE_COOKIE` follows it, for the session's, the
  `XSRF-TOKEN`, remember-me and your own cookies alike ([session configuration](../packages/session/README.md#configuration));
  the `web` group encrypts cookies with `APP_KEY`. A protected app on an `http://` `APP_URL` warns at boot.
- **Stores never see a session id:** a session is kept under the SHA-256 of the id in its cookie, so a leaked file, row or Redis
  key is no cookie; `SESSION_ENCRYPT=true` encrypts the payload as well
  ([hashed keys and encryption](../packages/session/README.md#hashed-keys-versions-and-encryption-e144-e145)).
- **Signing in or out renews the session**, and signed-in answers are `Cache-Control: no-store, private` — Back after signing out
  shows nothing from the HTTP cache ([never cached](../packages/auth/README.md#signed-in-answers-are-never-cached)). Signing out
  also sends `Clear-Site-Data`, and the other tabs of the browser follow by themselves
  ([tab sync](../packages/http/README.md#tab-sync-w8-step-8)).
- Read-only requests (islands, live streams, the session epoch) never write a session or a cookie.

## Keys

`APP_KEY` encrypts cookies and sealed sessions and signs URLs; anyone who has it can forge them. Generate it once per environment
(`bespoke key:generate`), keep it out of the repository and the image (the generated `.dockerignore` keeps every `.env*` out), and
rotate it with `APP_PREVIOUS_KEYS`: old cookies and signed URLs stay readable until they expire
([key rotation](../packages/encryption/README.md#key-rotation)).

## Pages and scripts

- **Content-Security-Policy:** `contentSecurityPolicy()` gives every document a policy with a fresh nonce — scripts only with that
  nonce (`'strict-dynamic'` for the chunks they load), no plugins, no foreign `<base>`. The starter kit and the web app turn it on
  ([Content-Security-Policy](../packages/http/README.md#content-security-policy-e147)). A nonce must never reach a shared cache: a
  page cached publicly gets a policy without one (the docs: `script-src 'self'` — they have no inline script).
- **Escaping:** React escapes what pages render; HTML written by hand goes through the `html` template of core
  ([escaping](../packages/core/README.md#html-the-escaping-html-template)). Page data travels as JSON in an inert
  `<script type="application/json">`.
- **Security headers:** the starter kit's `middleware/SecurityHeaders.ts` sends `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY` on every response; its HSTS switch is off until
  you turn it on — once the site answers over HTTPS only (or let the proxy send `Strict-Transport-Security`).
- **Behind a proxy**, `X-Forwarded-*` count only from `TRUSTED_PROXIES` — otherwise any client could choose its own IP address
  (rate limits, logs) and its scheme ([behind a proxy](../packages/server/README.md#behind-a-proxy-e162)). `*` trusts the
  direct peer only (E172): `ctx.ip` is the address that peer saw (the right-most `X-Forwarded-For` entry), never one a client
  wrote before it — but only when nothing but your proxy can reach the app; prefer its address or network where you know it.
- **No dynamic compression** of documents in the framework (BREACH): assets are compressed at build time; leave documents
  uncompressed at the proxy too ([deployment](deployment.md#proxies-and-http2)).

## Accounts

- Passwords are hashed with Argon2id ([password hashing](../packages/auth/README.md#password-hashing)); the generated auth module
  rate-limits sign-in (per address and client together), registration (per client), reset mails (per client and per address)
  and a signed-in user's password checks — confirmation, password change, "sign out other devices" (per user)
  ([rate limits](../packages/cache/README.md#rate-limits)). The password change and "sign out other devices" run one at a time
  per session (`block()`).
- Registration tells by default whether an address is taken (like Laravel's starter kits). `make:auth --private-registration`
  answers every registration the same way, in the same time, and mails the owner instead; the app's routes then ask for a
  confirmed address (`verified()`)
  ([private registration](../packages/auth/README.md#private-registration---private-registration-e146)).
- Policies and the `Gate` decide what a user may do
  ([authorization](../packages/auth/README.md#authorization-policies-and-the-gate-e28)).

## Logs and recordings

Passwords, tokens, cookies and keys are redacted wherever the framework writes something down — the log, the request log line, the
devtools' recordings — by one `Redactor` with one list of names ([redaction](../packages/core/README.md#redaction-e125)). Add the
names of your own secrets to it. The devtools exist in development only and refuse other hosts
([only in development](../packages/devtools/README.md#only-in-development-e115-fail-closed)).

## Your checklist

- `NODE_ENV=production` (or any protected value) in the server's environment, no development `.env` on the server.
- `APP_URL=https://…`, a fresh `APP_KEY` per environment, kept in the server's secrets.
- `contentSecurityPolicy()` in `bootstrap/app.ts` (the starter kit has it); new inline scripts take `ctx.nonce()`.
- HSTS once the site is HTTPS only — the `SecurityHeaders` switch or the proxy.
- `TRUSTED_PROXIES` set to exactly your proxy (`*` — the direct peer only — when nothing else can reach the app); the proxy sets
  `X-Forwarded-*` itself and does not compress documents.
- Sessions in `file`, `database` or `redis` (not `cookie`) for apps with sign-in; `SESSION_ENCRYPT=true` if the store is shared.
- Update in lockstep and read [UPGRADING.md](../UPGRADING.md); security fixes go to the latest minor version
  ([versions](versioning.md)).
