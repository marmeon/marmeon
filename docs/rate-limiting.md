# Rate Limiting

## Introduction

A rate limit caps how often something may happen in a window of time: ten registrations a minute from one client address, five
password guesses a minute for one e-mail address from one client. It slows down scripts that guess passwords, create accounts or
read a whole table, and it keeps one client from using up what everyone shares. The limits count in the app's [cache](cache.md),
so every new app has them.

You define a named limiter once, in a service provider's `boot()`, and put it on routes with `throttle()`:

```ts title="modules/newsletter/NewsletterServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class NewsletterServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    const limiter = app.container.make(RateLimiter);
    limiter.for('newsletter.subscribe', (ctx) => Limit.perMinute(10).by(clientKey(ctx.ip)));
  }
}
```

```ts title="modules/newsletter/routes.ts"
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { SubscribeController } from './controllers/SubscribeController.ts';

export default defineRoutes((Route) => {
  Route.middleware(throttle('newsletter.subscribe')).authorize(everyone).post('/newsletter', SubscribeController).name('newsletter.subscribe');
});
```

The eleventh subscription from one client within a minute gets a `429 Too Many Requests` instead of a mail. The starter kit's auth module
does the same for its routes, with limiters that `@marmeon/auth` defines.

A package can define limiters of its own: `@marmeon/auth` defines the `auth.*` ones for the starter kit's routes
([the limits of the auth routes](authentication.md#the-limits-of-the-auth-routes)). It defines a name only while it is free, so your
`limiter.for('auth.login', …)` replaces the default, whether your provider boots before or after the package. Replacing `auth.login` removes the protection against one client trying many addresses; keep a limit per client in it.

## Defining limiters

`limiter.for(name, callback)` names a limiter. The callback gets the request's context and returns a `Limit`, a list of them, or a
promise of either:

| Method | Window |
| --- | --- |
| `Limit.perSecond(max, seconds = 1)` | `max` attempts per `seconds` seconds. |
| `Limit.perMinute(max, minutes = 1)` | `max` attempts per `minutes` minutes: `Limit.perMinute(5, 10)` is five in ten minutes. |
| `Limit.perHour(max, hours = 1)` | `max` attempts per `hours` hours. |
| `Limit.perDay(max, days = 1)` | `max` attempts per `days` days. |
| `Limit.none()` | No limit. |
| `new Limit(max, decay)` | `max` attempts per `decay`: seconds, or a [`Duration`](time.md#spans-of-time) such as `{ minutes: 10 }`. A window of a fraction of a second is a `RangeError`. |

`.by(key)` says whose attempts count together. Use the client's address for guests and the user's id for signed-in users. A list
of limits counts each one on its own, and the first one that is used up refuses the request:

```ts title="modules/members/MembersServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class MembersServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(RateLimiter).for('members-table', (ctx) => {
      const key = String(ctx.user?.id ?? clientKey(ctx.ip));
      return [Limit.perMinute(60).by(key), Limit.perDay(1000).by(key)];
    });
  }
}
```

`ctx.user` is the signed-in user, of your app's user type, when `authenticate()` runs before `throttle()` on the route. Elsewhere it
is `undefined`, so the type says it may be missing. Without `@marmeon/auth` the context has no `user`.

> [!WARNING]
> A limit without `.by()` is one counter for every client. Ten registrations a minute then means ten for the whole app, and one
> script locks everyone else out.

`ctx.ip` is the client's address. Behind a proxy it is the client's only when the proxy is in `SERVER_TRUSTED_PROXIES`; otherwise every
visitor has the proxy's address and shares its limit. The [requests](requests.md#the-clients-address) page explains how the
address is found.

### Keys and the client's address

Key a limit on `clientKey(ctx.ip)`, not on `ctx.ip` itself. An IPv4 address is its own key. A household or office with IPv6 gets a
whole /64 block (2⁶⁴ addresses) and picks a new address inside it for every request, so a limit keyed on the full address
never fills; `clientKey()` returns the /64 (`2001:db8:1:2::/64`) for every address in the block, however it is written
(compressed, with leading zeros, with a zone id). An IPv4-mapped (`::ffff:203.0.113.9`) or NAT64 (`64:ff9b::/96`) address counts as its
IPv4 address, and a port or brackets that a proxy adds (`203.0.113.9:443`, `[2001:db8::1]:443`) are dropped. A request without an
address has the key `unknown`. Text that is not an address at all keeps a key of its own (`raw:…`), so one odd client never takes
everyone's budget, and logs a warning once: check what your proxy sends in `X-Forwarded-For`. `ctx.ip` itself stays the full address, for logs and the
sign-in list.

A client can not choose its own key: `X-Forwarded-For` only counts when the peer is in `SERVER_TRUSTED_PROXIES`, and the key is made from the
address the server found. Keying on the /64 means that everyone behind one IPv6 connection share a limit, like everyone behind one IPv4
address does.

## Applying limits to routes

`throttle(name)` is route middleware. Put it on a single route or on a group, like any other
[middleware](middleware.md#on-routes):

```ts title="modules/auth/routes.ts"
import { authenticate } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { ResendVerificationController } from './controllers/ResendVerificationController.ts';

export default defineRoutes((Route) => {
  const signedIn = Route.middleware(authenticate()).authorize(everyone);
  signedIn.middleware(throttle('auth.verification')).post('/email/verification-notification', ResendVerificationController);
});
```

- **Every request counts**, also one the controller then refuses, such as a form that fails validation. Requests that the `web`
  group stops first, such as a missing CSRF token, never reach the limit.
- **Counting and deciding are one atomic step.** A hundred requests at once against a limit of ten let exactly ten through, across
  processes when they share the cache.
- **Routes that use the same limiter share its counters.** The members table puts one limiter on its actions, bulk actions and
  export, so all three count together.
- **A limiter that is not defined** stops the server when it starts, once every provider has booted: `Rate limiter [members-table] is not defined,
  but POST /members/_tables/members/actions/:tableAction uses throttle('members-table'). Define it in a provider's boot(): app.container.make(RateLimiter).for('members-table', …).`

- **`marmeon check` finds the routes without one.** A route that anyone may call, that changes something (`POST`, `PUT`, `PATCH`
  or `DELETE`) and has neither `throttle()` nor `authenticate()` in front of it, in the route, its group or the app, is a
  [warning](check.md#routes-without-a-limit). `authenticate()` and `signed()` count as the same: such a route is not reported.

The window opens with the first attempt and does not move with later ones. Once it has passed, the count starts again at zero.

## The answer

A request over the limit gets a `429` with these headers:

| Header | Value |
| --- | --- |
| `Retry-After` | Seconds until the window ends. |
| `X-RateLimit-Limit` | The limit's maximum. |
| `X-RateLimit-Remaining` | `0`. |
| `X-RateLimit-Reset` | When the window ends, in seconds since 1970. |

Its message is the translation `marmeon.errors.throttled`, "Too Many Attempts." in English. A page, a form and a JSON client each
see it the way they see any other HTTP error, as the [error handling](errors.md#what-the-client-sees) page shows. A request within
the limit goes on, and its response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. With several limits, these two headers
describe the tightest one: the limit with the fewest attempts left.

### Live validations

A form that checks its fields while you type sends a live validation to the form's route. A `throttle()` on that route holds the
check to its limit, but the check does not count against it: checking a form field by field must not use up the tries of sending
it. Live validations have a limit of their own instead, in the global middleware: 30 a minute per route and client address. A
limiter named `live-validation` replaces it:

```ts title="modules/system/SystemServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class SystemServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(RateLimiter).for('live-validation', (ctx) => Limit.perMinute(60).by(clientKey(ctx.ip)));
  }
}
```

`Limit.none()` turns it off. The [validation](validation.md#live-validation) page explains live validation.

## Counting by hand

Some limits cannot be middleware, because their key comes from validated input. A sign-in counts per e-mail address and client
address together, and the e-mail address is known only once the controller has validated the form. Inject the `RateLimiter` and
count in the controller:

```ts title="modules/auth/controllers/LoginController.ts"
import { Auth } from '@marmeon/auth';
import { clientKey, RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const LoginRequest = defineRequest({
  schema: r.object({ email: r.string().trim().lowercase().required().email(), password: r.string().required() }),
});

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;

  constructor(auth: Auth, limiter: RateLimiter) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password } = ctx.body;
    const key = `login:${email}|${clientKey(ctx.ip)}`;
    if (!(await this.#limiter.attempt(key, 5, 60))) {
      const seconds = await this.#limiter.availableInSeconds(key);
      throw new ValidationError({ email: [`Too many attempts. Try again in ${seconds} seconds.`] }, { email });
    }
    const signedIn = await this.#auth.attempt(email, password);
    if (!signedIn.ok) {
      throw new ValidationError({ email: ['These credentials do not match our records.'] }, { email });
    }
    await this.#limiter.clear(key);
    return this.redirect().intended().route('dashboard');
  }
}
```

The attempt is counted **before** the password is checked, and a right password clears the count. Counting only after a failure
would let every guess that is sent at the same moment through. The key joins the e-mail address and the client address, so guesses
at many accounts from one client share no count, and one account guessed from many clients is not limited as a whole.

| Method | What it does |
| --- | --- |
| `attempt(key, max, decay)` | Counts one attempt and says whether it is within `max`, in one atomic step. A refused attempt counts too. |
| `hit(key, decay)` | Counts one attempt and returns the count of the window, this one included. |
| `attempts(key)` | The count of the window. |
| `tooManyAttempts(key, max)` | Whether `max` is used up. For showing a state, never for letting an attempt through. |
| `availableInSeconds(key)` | Seconds until the window ends. |
| `clear(key)` | Forgets the count. |

A second key can count the same sign-ins per account instead of per client: `login-account:` and a hash of the normalised address, 100
attempts in 86,400 seconds, cleared by a sign-in and by a password reset. Hash the address when a key would otherwise hold it, and count
an address without an account the same way (an account by its id, an unknown address by an HMAC), so the limit does not tell which exist. `Auth.attempt()` counts this way, see
[limits on password sign-ins](authentication.md#limits-on-password-sign-ins). The cost is one cache entry per address tried, kept for a
day: on a public site use the `database` or `redis` cache store and keep `cache:prune` scheduled.

> [!WARNING]
> Never check with `tooManyAttempts()` and count afterwards. Requests that check at the same moment all pass before any of them
> counts. `attempt()` counts and decides in one step.

## Where the counts live

The counts are entries of the app's cache, under `limiter:` and the key. They follow the cache's driver:

- `CACHE_DRIVER` is `file` by default, so a new app counts per machine. With more than one server, the cache must be one they
  share, `database` or `redis`. With `file` each machine counts on its own, and with `memory` each process.
- The key is stored as it is: a key with an e-mail address, such as `limiter:login:ada@example.com|203.0.113.7`, puts personal data
  into the cache until its window ends.
- `cache:clear` empties the counts with everything else, and every window starts again.
- A limit on the `database` driver counts on the cache's own connection, so a count survives a rollback of the request's
  transaction.

The [cache](cache.md#drivers) page covers the drivers.

## Testing

Tests run on the `memory` cache, and its windows follow the app's clock. `app.travel({ minutes: 1 })` lets a window pass without
waiting, as the [time](time.md) page shows.
