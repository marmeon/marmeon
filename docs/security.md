# Security

## Introduction

This page lists what a Marmeon app protects by itself, what it leaves to you, and where each part is explained. The defaults are
chosen to be safe when nobody changes them. Where a protection costs something, such as a dependency, a migration or a cache, it is
a switch, and this page says which way it points. The [checklist](#your-checklist) at the end sums up what to do before a server
goes live.

Found a vulnerability in the framework? Report it privately, as [SECURITY.md](../SECURITY.md) describes, never in a public issue.

## The environment decides, and fails closed

`NODE_ENV` is `development`, `test` or `production`; any other value stops the start. Two rules depend on it, and they are not
mirror images of each other:

- **Development tools run only with `NODE_ENV=development`.** The error page with the code that threw, the devtools, the
  `Server-Timing` header, the mail previews and Vite's dev server stay off everywhere else, `test` included.
- **Protections apply to `production` and to a server where nobody set `NODE_ENV`.** JSON logs, `migrate` asking for `--force`,
  the warnings at start-up and the absence of lab pages hold there. `test` belongs to the test runner alone: it turns every
  protection off, and development-only routes answer under it, so it never belongs on a server.

One check does not depend on `NODE_ENV` at all: an app whose routes do not all say who may call them does not start, in
development, in `test` and in `production`. The same holds for an open route that loads a record by any key. The
[authorization](authorization.md#every-route-decides) page has the rule.

`APP_ENV` names the environment (`staging`, `production`, a name of your own) and changes neither rule: `APP_ENV=local` on a
server with `NODE_ENV=production` is protected, and its development routes answer 404. A staging server is
`NODE_ENV=production APP_ENV=staging`, with the production builds of the framework and of React, so a server error never reaches
its visitors with a message or a stack.

A forgotten variable therefore never shows your source code to a visitor. Set `NODE_ENV` in the server's real environment, and
never deploy a developer's `.env`: `marmeon start` refuses to run when `development` comes from a
`.env`, `queue:work` and `schedule:work` warn loudly, and the start line says `development (APP_ENV=local, NODE_ENV from .env)`.
The [configuration](configuration.md#the-environment-node_env) page explains where `NODE_ENV` comes from.

Code that runs in the browser and in server rendering checks for development positively, as `development` or `test`, never as
"not production". Without a value, an error in the browser shows only its short code, such as `[marmeon:R2] users/Show`, no
development warning appears, and an error page rendered on the server carries no exception message.

## Development routes

The devtools at `/_marmeon/devtools` and the mail previews at `/_marmeon/mail` exist only with `NODE_ENV=development`. They sit
behind one host guard, `devOnly()` of `@marmeon/core/dev`: it answers `localhost`, `127.0.0.1`, `[::1]` and the host of `APP_URL`,
and gives every other `Host` a 403 before the handler runs. Every answer is `no-store` and `nosniff`, carries no CORS header, and
is shared with no other origin, neither as a resource nor as a window.

The attack it stops is DNS rebinding. A page on `evil.example` points its own name at `127.0.0.1`, reaches the developer's server
with `Host: evil.example`, and reads the answers as if they were its own: recorded requests, mails with reset links, source paths.

- `marmeon dev` puts Vite in front, and Vite refuses unknown hosts itself. It does not under HTTPS, with `server.https` in
  `vite.config.ts`, and not with `allowedHosts: true`. Then the guard alone protects the devtools and the mail previews, while
  Vite's own paths, such as source modules, and the development error page have no host check. Use either setting only on a
  network you trust, and keep `allowedHosts` a list. The [asset bundling](vite.md#the-dev-server) page covers Vite's settings.
- Vite's file serving has its own list of refused paths. With `marmeon dev`, it covers `storage/`, `dist/`, `.marmeon/` and
  database files (`*.sqlite`, `*.sqlite3`, `*.db`, `*.db3` and their companions) on top of Vite's own, so an app that listens beyond localhost, with
  `HOST=0.0.0.0`, does not hand out its database, private uploads or build output. Your own `server.fs.deny` entries are added.
- Vite's `.env` files and `VITE_*` variables are off: no variable reaches the public bundle by its name. `marmeon({ viteEnv: true })`
  turns them back on, and then every `VITE_*` variable of the process is public. See [environment variables](vite.md#environment-variables).
- A development route of your own takes the same guard. Outside `development` and `test` it answers 404 by itself, asked on every
  request: a route registered on a server by mistake stays shut. The [routing](routing.md#development-only-routes) page shows how.
- `*.localhost` names pass Vite, since they are loopback by definition, but not the guard, unless `APP_URL` names one.

## Requests from other sites

Every request of the `web` group that may change something is checked for cross-site request forgery. The browser's
`Sec-Fetch-Site: same-origin` passes, and a request from another site is refused with 403. Without Fetch Metadata, the `Origin`
header decides. Only a client that sends neither needs the session's token, and without it gets 419.

- Guests get no session just for a token. A session draws its token only when something needs it, and signing in or out renews it.
  A guest who only reads leaves no cookie behind, unless the page keeps a session, such as one with an upload field.
- Browsers send Fetch Metadata to secure origins only. Over plain HTTP the check falls back to `Origin`, then to the token. Serve
  production over HTTPS.
- Trust other origins with `CSRF_TRUSTED_ORIGINS`, and check webhooks by their signature with [`verifyWebhook()`](webhooks.md), which needs no `csrfExcept`.
- The `api` group has no session and no CSRF check, since every request proves itself with its [API token](api-tokens.md).

The [CSRF protection](csrf.md) page explains every stage.

## Sessions and cookies

- **Every cookie is `Secure` when `APP_URL` starts with `https://`:** the session cookie, `XSRF-TOKEN`, the remember-me cookie and
  your own. `SESSION_SECURE_COOKIE` overrides it either way. A protected app whose cookies go without `Secure` warns at start-up.
  The [session](session.md#secure-cookies) page has the details.
- **The session and remember-me cookies carry the `__Host-` prefix when they are `Secure`:** a neighbouring subdomain cannot set them
  for your domain. Only the prefixed names are read. The [session](session.md#the-__host--prefix) page has the details.
- **Cookies are encrypted** with `APP_KEY` in the `web` group, all but `XSRF-TOKEN`, which the browser's JavaScript reads. The
  session cookie is also `HttpOnly`.
- **The store never sees a session id.** A session is kept under the SHA-256 hash of its id, so a leaked file, row or Redis key is
  no cookie. `SESSION_ENCRYPT=true` encrypts the data as well. The [session](session.md#how-sessions-are-stored) page explains both.
- **Signing in or out renews the session:** a new id and a new CSRF token, so an id handed out before signs nobody in.
- **Signed-in answers are `Cache-Control: no-store, private`,** so Back after signing out shows nothing from the browser's cache.
  Signing out also sends `Clear-Site-Data`, and the other tabs of the browser follow by themselves. The
  [authentication](authentication.md#signed-in-pages-are-never-cached) and
  [client features](client-features.md#the-browsers-storage-on-sign-out) pages explain them.
- **Requests that only read never write.** Islands, live streams and the tabs' session checks write no session data and set no
  cookie. The [request lifecycle](lifecycle.md#requests-that-only-read) page lists them.

## A link that is a credential

A page whose URL grants a right (an invitation, a ticket, a one-time link, a confirmation to leave a list) must not stay in a shared
cache, a search index or another site's logs. Put `credentialPage()` on the routes that carry the token:

```ts title="modules/events/routes.ts"
const tickets = Route.middleware(credentialPage()).middleware(throttle('tickets'));

tickets.authorize(everyone).bind('ticket', TicketRepository, { public: true }).get('/tickets/:ticket', ShowTicketController);
```

Every answer of those routes then carries `Cache-Control: no-store, private`, `X-Robots-Tag: noindex, nofollow` and
`Referrer-Policy: no-referrer`: the page, the JSON of a partial reload, a redirect, and the errors the route itself answers with (the
binder's 404, `abort()`, the 403 of `signed()`, the 429 of `throttle()`, a 422, a 500 in production). Put the middleware in front of
`throttle()` and `signed()`, so their refusals carry the headers too. A middleware that answers before the route, such as the CSRF check
(419), the protocol gate (409) or, in development, the error page for a 5xx, does not. `Cache-Control` replaces any value the route set;
a `Referrer-Policy` of `no-referrer` or `same-origin` that a controller set stays.

- **`public` binding, one throttle, one 404.** A binder with `{ public: true }` finds the row by the token's hash; a wrong token, a
  used link and a token of the wrong shape all answer the same 404. Throttle the route, so a token cannot be guessed by trying.
- **`no-referrer`, because the token is in the path.** The browser's default, `strict-origin-when-cross-origin`, keeps the path from
  other sites, but every request of your own origin from the page would send the token in its `Referer`, and the next page would read
  it in `document.referrer`, where analytics and proxy logs pick it up. The app stores only the token's hash, so it must not hold the
  token anywhere else.
- **A form behind a token.** Without a `Referer`, `back()` has nowhere to go (it lands on `/`), and a browser without Fetch Metadata
  sends `Origin: null` with the post, which the CSRF check cannot match. So let the token route trade the token for the row's id in
  the session and redirect to a page without it. That page and its post use `credentialPage({ referrer: 'same-origin' })`, and a
  failed validation returns to it with its errors and `old()` input. The trade has rules of its own:
  - Call `session.regenerate()` before the `put`, so a session id planted by whoever sent the link carries nothing.
  - Show on the page what the invitation is for (the workspace, the event), so a visitor sent to an attacker's link can tell.
  - Look the row up again on the page and on the post, in `authorize` of the request so it runs before the schema; a session
    that holds an id is no right by itself (the link may be used up or revoked since), and a visitor without one gets a 404.
  - After the use, `redeem()` the row and `session.forget()` the id.

  A request class with a schema always returns with `back()` on a failure. A form that must keep the token in its path validates in
  its controller instead, and redirects to its own URL with `this.redirect(…)` and the input.

The [URL generation](urls.md#a-link-that-is-used-once) page shows how to make and look up the token. The [code](#a-form-behind-a-token-in-code) below puts the rules together.

### A form behind a token, in code

An invitation into a workspace, from the link to the accepted membership. Only the first route has the token in its path. It
trades the token for the invitation's id in the session, and every route after it is addressed without a token:

```ts title="modules/invitations/routes.ts"
import { authenticate } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { abort, credentialPage, defineRoutes, describeAccess, everyone } from '@marmeon/http';
import { AcceptInvitationController } from './controllers/AcceptInvitationController.ts';
import { ContinueInvitationController } from './controllers/ContinueInvitationController.ts';
import { OpenInvitationController } from './controllers/OpenInvitationController.ts';
import { ShowInvitationController } from './controllers/ShowInvitationController.ts';
import { InvitationRepository } from './InvitationRepository.ts';
import { PendingInvitation } from './PendingInvitation.ts';

export default defineRoutes((Route) => {
  // The trade. The binder finds the row by the token's hash, and answers 404 for any other value (see "A link that is used once").
  Route.middleware(credentialPage())
    .middleware(throttle('invitations'))
    .authorize(everyone)
    .bind('invitation', InvitationRepository, { public: true })
    .get('/invitations/:invitation', OpenInvitationController);

  // The page and its post. The check looks the row up again, once per request, and answers the same 404 without one.
  const pending = Route.middleware(credentialPage({ referrer: 'same-origin' })).authorize(
    describeAccess(async (_ctx, resolve) => {
      if ((await resolve(PendingInvitation).find()) === undefined) abort(404);
      return true;
    }, 'pending invitation'),
  );

  pending.get('/invitation', ShowInvitationController).name('invitations.show');
  pending.middleware(authenticate()).post('/invitation', AcceptInvitationController);

  // Where "Sign in" on the invitation page leads: no token, so the session keeps nothing secret as the intended URL.
  Route.middleware(authenticate()).get('/invitation/continue', ContinueInvitationController).name('invitations.continue');
});
```

The trade gives the session a new id before it stores anything, so an id that whoever sent the link planted carries nothing. The
old id stops working and the session keeps its data, so the flow adds only the invitation's id, which is no secret and no right:

```ts title="modules/invitations/controllers/OpenInvitationController.ts"
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';

declare module '@marmeon/session' {
  interface SessionData {
    /** The invitation whose link this visitor opened: its id, never its token. */
    invitation: number;
  }
}

export class OpenInvitationController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<{}, { invitation: Row<'invitations'> }>) {
    this.#session.regenerate();
    this.#session.put('invitation', ctx.params.invitation.id);
    return this.redirect().route('invitations.show');
  }
}
```

`PendingInvitation` is the holder of the looked-up row. It is scoped, so the check of the route and the controller share one
query per request (register it with `container.scoped(PendingInvitation)`, as in
[a lookup once per request](authorization.md#a-lookup-once-per-request)):

```ts title="modules/invitations/PendingInvitation.ts"
import type { Row } from '@marmeon/database';
import { abort } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { InvitationRepository } from './InvitationRepository.ts';

export class PendingInvitation {
  readonly #session: Session;
  readonly #invitations: InvitationRepository;
  #row: Promise<Row<'invitations'> | undefined> | undefined;

  constructor(session: Session, invitations: InvitationRepository) {
    this.#session = session;
    this.#invitations = invitations;
  }

  /** The open invitation the session names, or `undefined`: none named, or used up or revoked since the link was opened. */
  find(): Promise<Row<'invitations'> | undefined> {
    this.#row ??= this.#lookup();
    return this.#row;
  }

  /** The same, or the 404 of a visitor who has no invitation. */
  async require(): Promise<Row<'invitations'>> {
    return (await this.find()) ?? abort(404);
  }

  async #lookup(): Promise<Row<'invitations'> | undefined> {
    const id = this.#session.get('invitation');
    return id === undefined ? undefined : this.#invitations.findOpen(id);
  }
}
```

The repository finds the row by the token's hash for the trade, as in [a link that is used once](urls.md#a-link-that-is-used-once),
and by id for everything after it:

```ts title="modules/invitations/InvitationRepository.ts"
import { hashLinkToken } from '@marmeon/encryption';
import { Repository, secretEquals, type Row } from '@marmeon/database';

export class InvitationRepository extends Repository<'invitations'> {
  static table = 'invitations' as const;

  /** `/invitations/:invitation` → the open row, or `undefined` for a 404. */
  override resolveRouteBinding(token: string): Promise<Row<'invitations'> | undefined> {
    return this.query().selectAll().where((eb) => secretEquals(eb, 'token_hash', hashLinkToken(token))).where('used_at', 'is', null).executeTakeFirst();
  }

  /** An invitation that is not used up. A revoked one is a deleted row. */
  findOpen(id: Row<'invitations'>['id']): Promise<Row<'invitations'> | undefined> {
    return this.query().selectAll().where('id', '=', id).where('used_at', 'is', null).executeTakeFirst();
  }

  /** True for exactly one caller, however many arrive at once: the update decides, not an earlier read. */
  async redeem(id: Row<'invitations'>['id']): Promise<boolean> {
    const result = await this.db.updateTable('invitations').set({ used_at: new Date() }).where('id', '=', id).where('used_at', 'is', null).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}
```

The page says what the invitation is for. Its form posts to `/invitation`, with no token in the path, so `back()` and the CSRF
check work as on any page, and a failed validation returns to it with its errors:

```ts title="modules/invitations/controllers/ShowInvitationController.ts"
import { Controller } from '@marmeon/http';
import { PendingInvitation } from '../PendingInvitation.ts';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository.ts';

export class ShowInvitationController extends Controller {
  readonly #pending: PendingInvitation;
  readonly #workspaces: WorkspaceRepository;

  constructor(pending: PendingInvitation, workspaces: WorkspaceRepository) {
    super();
    this.#pending = pending;
    this.#workspaces = workspaces;
  }

  async handle() {
    const invitation = await this.#pending.require();
    const workspace = await this.#workspaces.findOrFail(invitation.workspace_id);
    return this.view('invitations/Show', { workspace: workspace.name, role: invitation.role });
  }
}
```

The post redeems the row and writes the membership in one transaction. The role comes from the invitation's row, never from the
request. Afterwards the session forgets the id:

```ts title="modules/invitations/controllers/AcceptInvitationController.ts"
import type { Authenticated } from '@marmeon/auth';
import { err, ok } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { InvitationRepository } from '../InvitationRepository.ts';
import { PendingInvitation } from '../PendingInvitation.ts';
import { MembershipRepository } from '../../workspaces/MembershipRepository.ts';

export class AcceptInvitationController extends Controller {
  readonly #connections: Connections;
  readonly #pending: PendingInvitation;
  readonly #invitations: InvitationRepository;
  readonly #memberships: MembershipRepository;
  readonly #session: Session;

  constructor(connections: Connections, pending: PendingInvitation, invitations: InvitationRepository, memberships: MembershipRepository, session: Session) {
    super();
    this.#connections = connections;
    this.#pending = pending;
    this.#invitations = invitations;
    this.#memberships = memberships;
    this.#session = session;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const invitation = await this.#pending.require();
    const accepted = await this.#connections.transaction(async () => {
      // Used up meanwhile: the lost redeem answers like a link that never existed.
      if (!(await this.#invitations.redeem(invitation.id))) return err({ kind: 'used' });
      const added = await this.#memberships.tryInsert({ workspace_id: invitation.workspace_id, user_id: ctx.user.id, role: invitation.role });
      // Already a member: the err rolls the redeem back, so the invitation stays open.
      return added.ok ? ok(invitation.workspace_id) : err({ kind: 'member' });
    });
    if (!accepted.ok) abort(404);
    this.#session.forget('invitation');
    return this.redirect().route('workspaces.show', { workspace: accepted.value });
  }
}
```

The sign-in link on the page points to `/invitation/continue`, which sends a guest to the sign-in and back
([sending a guest from an open page to sign in and back](authentication.md#sending-a-guest-from-an-open-page-to-sign-in-and-back)).
A sign-in keeps the session's data, so the invitation's id is still there afterwards. For a visitor who has no account yet, see
[an invitation for someone without an account](authorization.md#an-invitation-for-someone-without-an-account).

### A public page that carries a token only sometimes

A page that is public for everyone and holds a token in its query only for some visitors (`?invite=`, `?g=`) is no credential
without the parameter. Name the parameters, and the headers follow the request:

```ts title="modules/events/routes.ts"
Route.middleware(credentialPage({ query: ['invite'] })).get('/events/:event', ShowEventController);
```

A request whose query has `invite` (also `?invite=` with no value) gets the headers above; any other answer stays as the route made
it. A cache keys on the whole URL (check that your CDN does not ignore the query string for this path), so the page without the parameter may be cached while `?invite=…` never is. Names are matched
exactly, `Invite` is another parameter. Leave `query` out for a route whose path is the credential.

Two `credentialPage()` on one route, each for its own parameter, give the stricter `Referrer-Policy` to a URL that has both: with
`?g=` (`no-referrer`) and `?invite=` (`referrer: 'same-origin'`), the answer is `no-referrer`, so neither token travels in a same-origin
`Referer`. `same-origin` sends the URL, token included, to your own origin, so choose it only as in "A form behind a token" above.

## Keys

`APP_KEY` encrypts cookies, encrypted jobs and sealed sessions, and the keys that sign URLs, live channels and uploads are derived
from it. Anyone who has it can read and forge all of them. Generate it once per environment with `marmeon key:generate`, keep it
out of the repository and out of the image, and rotate it with `APP_PREVIOUS_KEYS`, so that old cookies and signed links stay valid
until they expire. The [encryption](encryption.md#rotating-the-key) page explains the key and its rotation. After a leak the procedure differs: do not keep the leaked key, see [ending every session of every account](authentication.md#ending-every-session-of-every-account).

## Pages and scripts

- **Content Security Policy.** `contentSecurityPolicy()` gives every document a policy with a fresh nonce: scripts only with that
  nonce, and the chunks they load, no plugins, no foreign `<base>`. Every new app turns it on. A nonce must never reach a shared
  cache: the app warns when a publicly cached page carries one. The [Content Security Policy](csp.md) page explains the policy.
- **Styles without `'unsafe-inline'`.** The framework renders no `style` attribute, so `styleSrc: ["'self'"]` blocks nothing of
  its own in a built app. Your own `style` props need classes then, and `@marmeon/react/styles.css` is imported in the client
  entry. The [styling](styling.md#no-style-attributes) page shows how.
- **Escaping.** React escapes what pages render. HTML you write by hand goes through the `html` template of `@marmeon/core`, as
  the [responses](responses.md#html-you-write-yourself) page shows. Page data travels as JSON in an inert
  `<script type="application/json">`. The browser reads an island's or a deferred group's streamed data only from such a script
  with its own `id`, so sanitised user HTML that guesses an `id` cannot replace it, and a deferred block only fills the props of
  its own group.
- **Security headers.** A new app lists `securityHeaders()` from `@marmeon/http`, which sends `nosniff`, a strict `Referrer-Policy` and
  `X-Frame-Options: DENY` on every response. Its `hsts` option for `Strict-Transport-Security` is off until you turn it on, once the
  site answers over HTTPS alone; no route can weaken `nosniff` or HSTS. The [Content Security Policy](csp.md#the-other-security-headers) page lists them.
- **Behind a proxy,** `X-Forwarded-*` headers count only from the addresses in `SERVER_TRUSTED_PROXIES`. Otherwise any client could choose
  its own address, for rate limits and logs, and its own scheme. `*` trusts the direct peer only, and is safe only when nothing
  but your proxy can reach the app. The [deployment](deployment.md#trusted-proxies) page explains the values.
- **No compression of documents.** A compressed page that holds a secret next to text an attacker controls leaks the secret byte
  by byte. The framework compresses assets at build time and never pages; leave pages uncompressed at the proxy too, as the
  [deployment](deployment.md#compression) page says.

## Strict-Transport-Security

The first visit to `http://your-site` is open to an attacker on the path, who can keep the browser on plain HTTP (SSL stripping).
`Strict-Transport-Security` tells a browser that has seen it to use HTTPS alone for the `maxAge` you give. It is off until you
turn it on, because browsers hold on to it: switch it on once the site answers over HTTPS only, with a short `max-age` first.

```ts
securityHeaders({ hsts: { maxAge: { days: 365 }, includeSubDomains: true } })
```

`maxAge: 0` withdraws it from the browsers that have seen it. The header is sent on HTTPS responses only; behind a proxy that
means `SERVER_TRUSTED_PROXIES` and its `X-Forwarded-Proto`. A proxy may set the header instead of the app.
[`marmeon check`](check.md#hsts) warns when it finds none, before you go live.

## Accounts

- **Passwords** are hashed with Argon2id, within bounds that a planted hash cannot exceed. The [hashing](hashing.md) page explains
  the drivers and costs.
- **Rate limits.** The starter kit limits the sign-in per address and client together, the registration per client, reset mails
  per client and per address, and a signed-in user's password checks per sign-in, and per account for a sign-in that did not begin with a typed password: the confirmation, the password change and "sign
  out other devices". The password change and "sign out other devices" run one at a time per session. The
  [rate limiting](rate-limiting.md#defining-limiters) page covers limiters.
- **A session ends with the account's session key, not with its password hash.** Every new password, reset and "sign out other
  devices" writes a new key, and a session keeps only a fingerprint of the account's id and that key. A rehash at sign-in (new
  `HASH_*` costs) writes the hash alone and ends nothing, so raising the costs signs nobody out. A hash you write yourself, in an admin
  tool or a script, ends no session either: write a new key with it, or call `AccountSessions.end()`. The
  [authentication](authentication.md#changing-the-password) page explains how.
- **A sign-in tells nothing.** An unknown address and a wrong password get the same answer in the same time. The
  [authentication](authentication.md#signing-in) page explains how.
- **Validation never tells whether a record exists while a field is typed.** The `unique` and `exists` rules and an async
  `custom()` do not run in a live validation unless the rule says `.live()`, which a rule that asks about accounts must never do.
  Without it, a free and a taken address get the same answer there, and only a submit tells, behind its rate limit. A schema of
  another library runs live only when its request says `live: true`, which a form that asks about accounts must never say either.
  The unique index stays the truth: `failOnDuplicate()` turns its conflict into a 422. The
  [validation](validation.md#database-rules-and-why-they-never-run-live) page explains why.
- **Mail goes out encrypted or not at all.** SMTP uses TLS from the first byte, or requires STARTTLS, so a server without it, or
  someone who strips the offer, never sees the credentials or a reset link. `MAIL_REQUIRE_TLS=false` turns the requirement off, for
  a local relay only. The [mail](mail.md#smtp-and-tls) page has the settings.
- **Policies decide what a user may do,** on every request: the session's user on a page, the token's user on a route behind
  `authenticate('api')`. Authorize an API route with the token's abilities and a policy. An ability only says what kind of action
  a token may do, never on whose record, so it alone leaves the records of every user open to whoever changes an id. The
  [authorization](authorization.md#policies-and-api-tokens) page shows both on one route.
- **Every route says who may call it.** The app does not start with a route that does not, and `abilities()` is not that decision.
  The [authorization](authorization.md#every-route-decides) page shows the check and its limits.
- **Open routes that change something have a limit.** `marmeon check` warns at a `POST`, `PUT`, `PATCH` or `DELETE` route that
  anyone may call, that is not behind a sign-in and that no `throttle()` limits: a contact form or an invitation to accept is
  free spam, brute force and cost (mails, jobs) otherwise. The [check](check.md#routes-without-a-limit) page says what it
  finds, and what it cannot.

### Private registration

The registration of the starter kit never tells whether an address has an account. This is the default:

- Every registration gets the same answer in the same time. The owner of a known address gets a mail instead of a second account.
- Registering signs nobody in. The auth module's pages ask for a confirmed address, so whoever registered with somebody else's
  address sees only a notice, and the owner takes the account over with a password reset. Your own routes need `verified()` for
  the same: the [email verification](verification.md#requiring-a-confirmed-address) page explains it.
- A change of address waits until the link sent to the new address is opened, with the same answer for a free and a taken address.

### Open registration

`AUTH_PRIVATE_REGISTRATION=false` turns all of this off. The registration and the change of address then say "taken", a new account
is signed in at once, and a new address takes effect at once. From then on only the registration's rate limit stands between the
form and a list of who has an account. Outside development and tests the app logs a warning about it at every start. Turn it off
only when the accounts of your app are public anyway. The [starter kit](starter-kit.md#turning-it-off) page shows the switch.

An unconfirmed account is then a working account. Whoever registers with somebody else's address uses it at once: the module's
`ConfirmedAddress` lets every signed-in user through, which is why the kit puts `verified()` on the routes that add a factor or create a token; your own routes need it too. When
the owner later takes the account over with a password reset, its sessions and remember-me tokens end. An API token created in the
meantime ends with them too, because the account was never confirmed (see below); an API token of a confirmed account ends only with
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`.

The routes that add an authenticator app or a passkey sit behind `verified()` in every registration mode, so an account whose address
nobody confirmed cannot attach a second factor of its own. And the password reset of such an account (`email_verified_at` and `first_verified_at` are `null`: the address was never confirmed)
removes its passkeys, its authenticator, its recovery codes and every API token, whatever `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` says:
the owner proved the mailbox with the link, and nothing the first registrant attached stays. The reset leaves the address unconfirmed;
the owner confirms it with the link of the notice page. A confirmed account loses nothing in a reset.

### Accounts nobody confirmed

`auth:prune-unverified` deletes accounts whose address was never confirmed, `AUTH_UNVERIFIED_DAYS` days after the sign-up, 7 by
default. An account confirmed once is never deleted. The command runs only when your app turns its line on in
`modules/auth/schedule.ts`, because deleting accounts is your app's decision. Once it runs, whoever registered with somebody
else's address stops holding it, and nothing of an unfinished sign-up stays: the account, its tokens and what other modules keep
go, and its sessions end. With open registration, such an account was signed in and may have used the app before it goes. Without
the line, these accounts stay: decide it for your app. The [email verification](verification.md#unconfirmed-accounts) page
explains the rules.

## Secret columns and raw SQL

Which columns are secret comes from the migrations ([how the app knows its schema](migrations.md#how-the-app-knows-its-schema)), so the
guard covers what the blueprint made and nothing else:

- A table that raw SQL, a view or another tool made has no secret columns, soft deletes or timestamps, and `selectAll()` on it is
  `select *`. Create what holds secrets with `schema.create()` and mark the column `.secret()`.
- Raw SQL, in a query or in a migration, is not checked: `` sql`select * from users` `` returns the hash.
- A connection with `managed: false` knows no secret column at all.
- A process that runs older code against a newer database selects only the columns it knows, so a column a newer migration marks
  secret is not in its `selectAll()` ([migrating a running app](migrations.md#migrating-a-running-app)).

## Tables and exports

A table of `@marmeon/table` is one definition the server enforces on every request. These are the attacks of hand-written tables,
and what stops each:

- **Hidden columns stay hidden.** A column the policy hides is not selected: not in the SQL, so not in the props, the devtools'
  query log, a cursor or an export. The props are picked by name besides.
- **No sort oracle.** Sorting, filtering or searching by a column the user cannot see is a 400, as is any sort, filter or page size
  the definition does not name, such as `?sort=password` or `?per_page=10000`. An order by a secret would tell its values without
  showing them. Nothing from the URL reaches `ORDER BY` or `WHERE` that the definition did not name.
- **No bulk IDOR.** A bulk action acts on the keys sent, within the base query, and only on rows the policy allows. Another
  tenant's key or a made-up one is left out as missing, and a row the policy refuses is skipped. "All matching" sends the filter,
  never keys, and the server refuses more rows than the action's `max` with 422. Put the tenant into the base query: every endpoint
  starts from it. The endpoints take the middleware of the page's route registrar, not the page controller's `authorize`, so a
  table that needs one declares it.
- **No CSV injection.** Exported text cells that start with `=`, `+`, `-`, `@`, a tab or a line break get a `'` in front, and every
  field is quoted. An export has its own `authorize` and a row limit, 10 000 by default, beyond which it answers 422 before the
  first byte. Rate-limit it as well: it reads the whole filtered table. A download is not recorded by itself: add
  `exportCsv().onExport(Recorder)` and its `handle()` runs before the first byte of every export that was allowed, and a recorder that
  throws stops the download ([exports](tables.md#exports)).
- **Keys are parsed by their declared type** before any query, so text never reaches an integer column.

The cursors of `cursorPaginate()` and of cursor tables are encrypted with the app key: a hidden sort column's value never shows in
a URL, and a changed or made-up cursor is a 400. The [tables](tables.md#the-security-model) and
[pagination](pagination.md#cursors) pages explain both.

## Live updates

Live props send hints, never data. A tab that gets a hint reloads through the page's route, its middleware and its policies, so a
hint can never show what the user may not see. A subscription is signed for its session, and another channel or another session's
token answers 403. Limits keep one user from exhausting a process: at most 16 streams per session
(`LIVE_MAX_STREAMS_PER_SESSION`, beyond it 429 and a warning in the log), 1000 per process (`LIVE_MAX_STREAMS`, beyond it 503) and
20 channels per stream. The limit per session counts by session, not by address; a flood of fresh sessions meets the limit per
process, so limit connections at the proxy as well. The [real-time updates](realtime.md#limits) page explains them. A stream checks its
sign-in whenever it opens, and ending an account's sign-ins (a new password, `AccountSessions`, an ended sign-in) closes its open
streams at once; a stream also closes after `LIVE_MAX_STREAM_SECONDS` (15 minutes) and is checked again.

## Logs and recordings

The log masks the values of keys that look like secrets, such as `password`, `token`, `cookie` or `authorization`, in nested
objects too, and the names packages add to the app's `Redactor`, such as the session cookie's. A `URL` in the context, and the
message and stack of an error under any key, are masked as text. Every other string, the message included, is written as it is,
so never put a secret into one. The [logging](logging.md#keeping-secrets-out-of-the-log) page lists the rules, and
the app's `Redactor` for text you must log.

The devtools' recordings, the development error page and traces go further: the same `Redactor` also masks every string there.
The devtools exist in development only and refuse other hosts. The [logging](logging.md#what-the-framework-shows-elsewhere) page
explains what each shows.

## Traces

With `@marmeon/otel`, a request from outside starts a trace of its own, and an incoming `traceparent` header is only a link to the
caller's span. A client cannot put its requests into a trace it chose, nor switch their recording on or off with the sampled flag,
and its baggage is dropped. `MARMEON_OTEL_TRUST_TRACEPARENT=true` continues the caller's trace: set it only behind an edge that sets or
strips the header, such as a gateway, an ingress or a mesh. `SERVER_TRUSTED_PROXIES` is no reason, since a proxy usually passes the
client's header on unchanged. The [observability](observability.md#a-callers-traceparent) page covers tracing.

## Your checklist

- `NODE_ENV=production`, or another protected value, in the server's environment, and no developer's `.env` on the server.
- `APP_URL=https://…`, and a fresh `APP_KEY` per environment, kept in the server's secrets.
- `contentSecurityPolicy()` in `bootstrap/app.ts`, which a new app has. New inline scripts take `ctx.nonce()`. With a `styleSrc`,
  classes instead of `style` props, and `@marmeon/react/styles.css` imported in the client entry.
- The lifetimes of a sign-in: `AUTH_SESSION_MAX_HOURS` as long as you accept a stolen session to work (24 hours by default),
  `AUTH_REMEMBER_DAYS` for "Keep me signed in" (a convenience at AAL1; 30 at most, 0 turns it off), and `SESSION_LIFETIME_MINUTES=60`
  where AAL2 is needed, which holds only behind `twoFactor()`.
  [How long a sign-in lasts](authentication.md#how-long-a-sign-in-lasts) lists them all.
- The `sign_ins` table (`marmeon make:sign-ins-table` for an app without the starter kit), and `auth:prune-tokens` scheduled
  ([sign-ins](authentication.md#sign-ins)). The starter kit does both.
- A `UserProvider` that writes its hash and session key with `credentialWriter()` (the starter kit's does), and stores of your own
  that extend the abstract classes and never a `Database…` store ([what your app implements](authentication.md#what-your-app-implements)).
  A provider that writes the statements itself tests that a stale `expected` and a stale `expectedSessionKey` return `false`.
- After an incident, `AccountSessions` ends every session and remember-me cookie of an account
  ([ending every session of a user](authentication.md#ending-every-session-of-a-user)).
  After a leak, `marmeon auth:end-all-sessions --force` ends every session of every account
  ([ending every session of every account](authentication.md#ending-every-session-of-every-account)).
- Your own controllers for sign-in, password reset, address change and passkey sign-in call the services of `@marmeon/auth` and keep none
  of their checks themselves: `Auth.attempt()`, `checkPassword()`, `PasswordBroker`, `EmailChange`, `Passkeys`. The limits inside them come
  with them. The `auth.*` limiters sit on the starter kit's routes; put the matching `throttle('auth.…')` on your own route
  ([what the package decides](authentication.md#what-the-package-decides)). The registration is the app's: its answer for a taken address,
  its mail limits and its pruning of unconfirmed accounts are the starter kit's code, or yours.
- No `sql.raw()` or `sql.lit()` with a value from a request: `marmeon check` reports each one that is not a literal
  ([raw SQL](check.md#raw-sql)).
- No `dangerouslySetInnerHTML` or `innerHTML` with a value from a request: show it as text. `marmeon check` reports each one
  that is not a literal ([HTML from code](check.md#html-from-code)).
- `verified()` after `authenticate()` on every route of your own that signed-in users reach.
- Every route of your own has a decision that you chose: a policy for a record, `everyone` only when anyone the middleware lets
  through may call it. `marmeon route:list` shows the `ACCESS` of each route.
- `marmeon dev` over HTTPS or with `allowedHosts: true` only on a trusted network. Staging private, since it shows server errors.
- Whether unconfirmed accounts go: the `auth:prune-unverified` line in `modules/auth/schedule.ts`, and `AUTH_UNVERIFIED_DAYS` as you
  want it, 7 by default. With `AUTH_PRIVATE_REGISTRATION=false`, tell your users that an unconfirmed account goes, and set
  `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`.
- `abilities()` on every API route that acts: without it, every token of a user acts with all of the user's rights.
- `MARMEON_OTEL_TRUST_TRACEPARENT` only behind an edge that owns the header, and `MARMEON_OTEL_RECORD_QUERY_VALUES` only when your URLs carry no
  personal data.
- [HSTS](#strict-transport-security) once the site answers over HTTPS only: the `hsts` option of `securityHeaders()`, or the proxy.
  `marmeon check --only=boot,hsts` with the production environment tells you whether the app sends it.
- `SERVER_TRUSTED_PROXIES` set to exactly your proxy, or `*` for the direct peer when nothing else can reach the app. The proxy sets
  `X-Forwarded-*` itself and does not compress pages.
- `SESSION_ENCRYPT=true` when the session store is shared.
- Tables: the tenant in the base query, `endpoints()` attached to the page's route, an `authorize` for exports, a `throttle` on the
  table's routes.
- Update the framework's packages together and read [UPGRADING.md](../UPGRADING.md). Security fixes go to the latest minor
  version (and, from 1.0 on, to the previous major for 12 months), as the [releases](releases.md#which-versions-get-fixes) page
  explains.
