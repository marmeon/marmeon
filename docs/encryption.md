# Encryption

## Introduction

`@marmeon/encryption` encrypts and decrypts text with the application key, `APP_KEY`. The framework uses it for every cookie, for
queued jobs that carry secrets, for session data and for the cursors of lists. Your code uses it for anything that leaves the
server and must come back unread and unchanged, such as a value in a link:

```ts title="modules/exports/ExportLinks.ts"
import { Encrypter } from '@marmeon/encryption';

export class ExportLinks {
  readonly #encrypter: Encrypter;

  constructor(encrypter: Encrypter) {
    this.#encrypter = encrypter;
  }

  seal(exportId: number): Promise<string> {
    return this.#encrypter.encrypt(JSON.stringify({ exportId }), 'exports:download');
  }

  async open(payload: string): Promise<{ exportId: number }> {
    return JSON.parse(await this.#encrypter.decrypt(payload, 'exports:download'));
  }
}
```

The encryption is AES-256-GCM, from Node's own `node:crypto`. It is authenticated: without the key, nobody can read a payload, and
nobody can change one without `decrypt()` noticing.

## The application key

`APP_KEY` is `base64:` followed by 32 random bytes in base64, a 256-bit key. A new app gets one when it is created. The command
writes one into `.env`:

```sh
pnpm marmeon key:generate          # writes APP_KEY into .env, copied from .env.example when there is no .env
pnpm marmeon key:generate --show   # prints a new key and writes nothing
pnpm marmeon key:generate --force  # replaces a key that is set, and keeps the old one for rotation
```

The command runs without starting the app, since a missing key is exactly why an app cannot start. It refuses to replace a key
that is set unless you pass `--force`, and its message says what `--force` does: it keeps the old key in `APP_PREVIOUS_KEYS`, so
nothing made with it breaks. `generateKey()` of `@marmeon/encryption` returns a key in the same format, for a test or a
script.

The app checks the key when it starts, with the rest of its configuration. A missing, empty or malformed key stops the start:

```text
• encryption: APP_KEY — Missing — run "marmeon key:generate"
• encryption: APP_KEY — Expected "base64:" followed by 32 base64-encoded bytes — run "marmeon key:generate"
```

A broken entry in `APP_PREVIOUS_KEYS` stops it the same way. `marmeon build` needs no key: the
[configuration](configuration.md#configuration-and-the-build) page explains why.

The key in the repository's `.env.test` files is public: outside `NODE_ENV=development` and `test` (a missing `NODE_ENV` included) the start refuses it, in `APP_KEY` and in `APP_PREVIOUS_KEYS` alike.

> [!WARNING]
> Whoever has `APP_KEY` can read every encrypted cookie and job, and forge cookies and signed URLs. Generate a key per
> environment, keep it in the server's secrets, and never commit it or bake it into an image. The `.dockerignore` that
> `marmeon make:docker` writes keeps every `.env` file out of the image.

When the key is missing or broken, the development error page and the output of `marmeon` show a solution, "Generate an
application key", with the command to copy. Nothing runs it for you.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_KEY` | none, required | The key everything is encrypted with: `base64:` and 32 random bytes. Every environment needs one, tests included. |
| `APP_PREVIOUS_KEYS` | empty | Former keys, comma-separated. What they encrypted still decrypts. |

## Encrypting and decrypting

Inject `Encrypter`. It is one object for the whole app.

| Method | What it does |
| --- | --- |
| `encrypt(plaintext, context)` | Returns the payload, a URL-safe string. |
| `decrypt(payload, context)` | Returns the text, or throws `DecryptError`. |

- **Text in, text out.** Turn values into text yourself, with `JSON.stringify()`, and parse them after decrypting.
- **Never the same payload twice.** Every call draws a fresh random IV, so encrypting the same text twice gives two payloads. The
  payload holds a version byte, the IV, the ciphertext and a 16-byte authentication tag, in base64url without padding. It fits
  into a cookie or a URL as it is.
- **One error for everything.** A changed byte, another key, another context, garbage or an empty string all end in the same
  `DecryptError`, "[marmeon:A4] The payload is invalid.". It never says which.
- **A context binds a payload to its use, and every call names one.** The second argument is required and authenticated with
  the payload. A payload encrypted for `exports:download` does not decrypt for another context. Give each use of your own a
  context of its own, so a value from one place cannot be replayed in another: an encrypted discount code would otherwise pass
  as an encrypted role flag. The empty string is refused with a `TypeError`, also for a caller that is not type-checked.

The framework's own contexts are `cookie:<name>`, `queue:v<N>:<job name>` for encrypted jobs, `session:<key>`,
`marmeon:cursor:…` for the cursors of lists and `marmeon-auth:two-factor:<user id>` for the secrets of two-factor
authentication. Choose names that start with none of `cookie:`, `session:`, `queue:` or `marmeon`.

### Values stored without a context

Payloads made without a context used the empty context, which makes them interchangeable with every other value stored the same
way. From 1.0 on, `decrypt()` refuses the empty context, and no method reads such payloads. Re-encrypt them **before you
upgrade, on 0.4**: there `decrypt(payload)` still reads the empty context and `encrypt(text, context)` already takes a context.

```ts
for (const row of await db.selectFrom('coupons').select(['id', 'code']).execute()) {
  const code = await encrypter.encrypt(await encrypter.decrypt(row.code), 'billing:coupon');
  await db.updateTable('coupons').set({ code }).where('id', '=', row.id).execute();
}
```

Deploy code that passes the context first, then upgrade. An app that skips 0.4 stays on it for one run to do this. An app that
never called `encrypt()` without a second argument has nothing to migrate.

Outside the container, `new AesGcmEncrypter(key, previousKeys)` takes raw 32-byte keys, and `AesGcmEncrypter.fromConfig(config)`
takes the resolved `EncryptionConfig`.

## What the key protects

| What | How |
| --- | --- |
| Every cookie of the `web` group | Encrypted with the context `cookie:<name>`. A changed, foreign or unencrypted value counts as absent. `XSRF-TOKEN` is the one exception, since the browser's JavaScript reads it. |
| Queued jobs | Jobs with `static encrypted = true`, and the framework's own: queued mails, queued listeners and notifications. |
| Session data | In its store, with `SESSION_ENCRYPT=true`. |
| Cursors | The cursors of `cursorPaginate()` and of tables. A changed or made-up cursor answers 400. |
| Signed URLs | Signed with a key derived from `APP_KEY`. |
| Live updates and uploads | The tokens of live channels and of uploads, each signed with a key derived from `APP_KEY`. |
| Tab sync | The session epoch the tabs compare, signed with a key derived from `APP_KEY`. |

Each purpose that signs gets a key of its own, derived from `APP_KEY` with HKDF-SHA-256. A signature is never also a cookie key.

An app whose `web` group has no `Encrypter` does not start: the error says to register `EncryptionServiceProvider` and set
`APP_KEY`. The queue and the live updates check the same when they need it.

## Rotating the key

After a leak the procedure differs: the leaked key must not stay in `APP_PREVIOUS_KEYS`, see [ending every session of every account](authentication.md#ending-every-session-of-every-account).

On more than one server, rotate in two deploys: first add the new key to `APP_PREVIOUS_KEYS` everywhere, then make it `APP_KEY`.
Every server can then read what any other writes. A job that a server still on the old key cannot decrypt waits, up to six hours,
for a worker that can (see [queues](queues.md#retries-and-failures)).

`encrypt()` always uses `APP_KEY`. `decrypt()` tries `APP_KEY` first and then each key of `APP_PREVIOUS_KEYS` in order. The keys
derived for signatures accept the previous keys too. So a rotation keeps everything valid that the old key made:

1. Run `pnpm marmeon key:generate --force`. It writes a new `APP_KEY` and moves the old one to the front of `APP_PREVIOUS_KEYS`,
   keeping the keys already listed there. Where the environment comes from somewhere else than `.env`, do the same there: the
   current key into `APP_PREVIOUS_KEYS`, a new one from `--show` into `APP_KEY`.
2. Deploy, with both variables on every server.
3. Remove the old key once nothing made with it is still around: sessions and remember-me cookies after their lifetime, queued and
   failed jobs, signed links after their expiry, and the two-factor secrets, which are encrypted again at their next use (a warning
   names a user whose secret is still under a removed key). Encrypted session data is encrypted with the new key at the session's next
   write. A "load more" cursor made with the old key answers 400 once the key is removed.

One thing follows the new key at once: the tabs of every browser find a new session epoch at their next check and reload once,
because the epoch uses the current key only.

Replacing `APP_KEY` without keeping the old one signs everybody out, because no session cookie decrypts any more. It also breaks
every signed link, and an encrypted job still waiting finds no worker that can read it: it is held for six hours and then fails with
`The encrypted payload of … cannot be decrypted with APP_KEY or APP_PREVIOUS_KEYS`. The
[deployment](deployment.md#rotating-app_key) page has the short version for a server.

## A short code a person types

A code a person types, such as a six-digit check-in code, has a million values: whoever reads the table can try them all against a
plain or unkeyed hash in a second. So the table keeps a keyed hash of the code, an HMAC-SHA256 under a key derived from `APP_KEY`.
A copy of the table without the key tells nothing about a code, and the app finds a row by the MAC of what the request brought.

The key is the only defence: whoever has the table and `APP_KEY`, or a key in `APP_PREVIOUS_KEYS`, computes all million MACs in under a
second. After a leaked key, do not keep it as a previous key: drop it and issue new codes.

```ts title="modules/events/CheckInCodes.ts"
import { createHmac, hkdfSync, randomInt } from 'node:crypto';
import { EncryptionConfig } from '@marmeon/encryption';

export class CheckInCodes {
  // The current key first, then the previous ones.
  readonly #keys: readonly Uint8Array[];

  constructor(config: EncryptionConfig) {
    this.#keys = [config.key, ...config.previousKeys].map(
      (key) => new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'events:check-in-code:v1', 32)),
    );
  }

  /** A new code to hand to a guest. */
  issue(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** The MAC of a code under each key, the current key's first. The event is part of the input, so two events can hold the same code. */
  macs(eventId: number, code: string): [string, ...string[]] {
    const input = `${eventId}:${code.trim().toUpperCase()}`;
    return this.#keys.map((key) => createHmac('sha256', key).update(input).digest('hex')) as [string, ...string[]];
  }
}
```

- **A key of its own.** HKDF turns `APP_KEY` into a key for this use alone. The `info` string names the use and starts with
  anything but `marmeon:`, which the framework's own derived keys use. Change the version at the end only when you want every
  stored MAC to stop matching.
- **Random codes.** `randomInt()` draws from the system's random source. A code from `Math.random()` or a counter can be predicted.
- **The column.** The MAC goes into a [secret column](migrations.md#secret-columns) with a unique index:
  `table.string('code_mac', 64).secret().unique()`. The MAC is 64 hex characters. The code itself is stored nowhere.

The lookup compares the MAC with [`secretEquals()`](queries.md#finding-a-row-by-a-hashed-secret). It takes a keyed MAC, since a
request cannot work its way towards a stored MAC bit by bit without the key, so the time of the comparison in SQL tells it nothing. A
code compared in your own code, such as one held in memory, is compared with `timingSafeEqual()` from `node:crypto`, never with
`===`.

```ts title="modules/events/GuestRepository.ts"
import { Repository, secretEquals } from '@marmeon/database';

export class GuestRepository extends Repository<'guests'> {
  static table = 'guests' as const;

  /** The guest one of these MACs belongs to, unless the code has expired (`now` is an ISO string). The MAC does not come back: it is a secret column. */
  findByCodeMac(macs: readonly string[], now: string) {
    return this.query()
      .selectAll()
      .where((eb) => eb.or(macs.map((mac) => secretEquals(eb, 'code_mac', mac))))
      .where('expires_at', '>', now)
      .executeTakeFirst();
  }

  /** True for exactly one caller, however many arrive at once: the update itself decides. */
  async markCheckedIn(id: number, at: string): Promise<boolean> {
    const result = await this.db
      .updateTable('guests')
      .set({ checked_in_at: at })
      .where('id', '=', id)
      .where('checked_in_at', 'is', null)
      .where('expires_at', '>', at)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}
```

```ts title="modules/events/EventRepository.ts"
import { Repository } from '@marmeon/database';

export class EventRepository extends Repository<'events'> {
  static table = 'events' as const;

  /** Locks the event's row until the transaction ends. */
  lock(id: number) {
    return this.query().select('id').where('id', '=', id).forUpdate().executeTakeFirst();
  }
}
```

The `guests` table has `event_id`, `code_mac`, `expires_at` and a nullable `checked_in_at`, both `table.timestamp(…)`.

```ts title="modules/events/CheckIns.ts"
import { Clock } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { CheckInCodes } from './CheckInCodes.ts';
import { EventRepository } from './EventRepository.ts';
import { GuestRepository } from './GuestRepository.ts';

const LIFETIME = 4 * 60 * 60 * 1000;

export class CheckIns {
  readonly #connections: Connections;
  readonly #events: EventRepository;
  readonly #guests: GuestRepository;
  readonly #codes: CheckInCodes;
  readonly #clock: Clock;

  constructor(connections: Connections, events: EventRepository, guests: GuestRepository, codes: CheckInCodes, clock: Clock) {
    this.#connections = connections;
    this.#events = events;
    this.#guests = guests;
    this.#codes = codes;
    this.#clock = clock;
  }

  /** Stores a new guest with a code no other guest of the event holds, under any key, and returns the code once. `undefined` for an unknown event. */
  issue(eventId: number, values: { name: string }) {
    return this.#connections.transaction(async () => {
      // One issue at a time per event. During a rotation the MACs differ per key, so the unique index alone cannot tell that two servers drew the same code.
      if (!(await this.#events.lock(eventId))) return undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = this.#codes.issue();
        const [current, ...previous] = this.#codes.macs(eventId, code);
        // A row holds this code under a previous key, or it has expired and still holds it: the unique index cannot see the first, so look for both.
        if (await this.#guests.findByCodeMac([current, ...previous], '1970-01-01T00:00:00.000Z')) continue;
        const expiresAt = new Date(this.#clock.now() + LIFETIME).toISOString();
        const result = await this.#guests.tryInsert({ ...values, event_id: eventId, code_mac: current, expires_at: expiresAt });
        if (result.ok) return { guest: result.value, code };
        // The only error is `duplicate`: draw again.
      }
      throw new Error(`No free check-in code for event ${eventId}`);
    });
  }

  /** The guest a code belongs to, unless it has expired. */
  async find(eventId: number, code: string) {
    const now = new Date(this.#clock.now()).toISOString();
    const [current, ...previous] = this.#codes.macs(eventId, code);
    const guest = await this.#guests.findByCodeMac([current], now);
    if (guest || previous.length === 0) return guest;

    // Not found under the current key: a row from before a rotation. Look under the previous keys and move its MAC to the current key.
    const stale = await this.#guests.findByCodeMac(previous, now);
    // A taken MAC is an `err`, not a throw. The guest is the right one either way, and the next check-in tries again.
    if (stale) await this.#guests.tryUpdate(stale.id, { code_mac: current });
    return stale;
  }

  /** Checks a guest in with the code. A code works once: the second call, and a call after the expiry, answer `undefined`. */
  async checkIn(eventId: number, code: string) {
    const guest = await this.find(eventId, code);
    if (!guest) return undefined;
    const used = await this.#guests.markCheckedIn(guest.id, new Date(this.#clock.now()).toISOString());
    return used ? guest : undefined;
  }
}
```

`issue()` is what keeps `find()` unambiguous. Six digits collide sooner than it seems: with a thousand guests at one event, two of them
share a code in about four cases of ten. The unique index refuses a repeat under the same key, and the look under every key refuses
a code that a row holds from before a rotation, where a new code could otherwise equal an old one and `find()` would return the wrong
guest. The lock on the event's row matters for the same reason: while a rotation rolls out, a server on the old key and one on the new
key can draw the same code at the same moment, both pass the look, and both insert, each with a MAC of its own. The lock closes that
only with the [two-deploy rotation](#rotating-the-key), where every server knows both keys, and at the default isolation level `read committed`.
On SQLite the clause is left out, since a write transaction there already runs alone. A longer code makes all this rarer, not unnecessary.

A code lives four hours (`LIFETIME`, from the app's [clock](time.md)) and works once: `markCheckedIn()` changes the row only while
`checked_in_at` is empty and the code has not expired, and it counts the rows it changed, so of two requests with the same code one wins.
An expired code keeps its row, and with it the code: `issue()` does not hand it out again.

A MAC cannot be turned into the MAC under a new key, because the code is not in the table. So a [rotation](#rotating-the-key) moves a
row to the new key when its guest checks in, and a guest who never does stays under the old one. Keep the old key in
`APP_PREVIOUS_KEYS` until the codes are used or expired. Once it is removed, a code that was never used under the new key no
longer matches: issue it again.

> [!WARNING]
> The MAC protects the table, not the route. A request that brings a code tests it against every live code of the event: with a
> thousand guests, one guess in a thousand hits, and a million guesses are enough for every code. The route that checks a code needs a
> [limit](rate-limiting.md) per client and one per event, and the short life of the codes above. Where only staff check guests in, key the limit
> by the signed-in user as well, behind `authenticate()` and an `authorize()` that lets staff only.

The limiter reads the event from the URL, where `ctx.params` holds raw strings, as the [rate limiting](rate-limiting.md#defining-limiters)
page says. A limiter runs before the route binding, and the binding takes `1`, `01` and `001` for the same event: a counter keyed on the
raw text would give each spelling its own budget. So the route accepts only the canonical spelling, and the key is made canonical too:

```ts title="modules/events/EventsServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';
import type { HttpContext } from '@marmeon/http';

export class EventsServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(RateLimiter).for('check-in', (ctx: HttpContext<{}, Readonly<Record<string, string>>>) => [
      Limit.perMinute(10).by(clientKey(ctx.ip)),
      Limit.perMinute(60).by(`event:${Number(ctx.params.event)}`),
    ]);

    // For a route behind authenticate(): one counter per member of staff, the client's address when there is none.
    app.container.make(RateLimiter).for('check-in.staff', (ctx) => [Limit.perMinute(60).by(String(ctx.user?.id ?? clientKey(ctx.ip)))]);
  }
}
```

```ts title="modules/events/routes.ts"
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { CheckInController } from './controllers/CheckInController.ts';

export default defineRoutes((Route) => {
  // No leading zero: `/events/01/check-in` is a 404, so one event has one address. `everyone` is for a kiosk a guest types the code at;
  // a route for staff takes `authenticate()` and a policy instead.
  Route.middleware(throttle('check-in')).authorize(everyone).post('/events/:event{[1-9][0-9]{0,14}}/check-in', CheckInController);
});
```

An event with a UUID key is made canonical with `ctx.params.event?.toLowerCase()`, since the binding also finds a UUID in capitals. A route
without the `event` parameter would put every request on one counter (`event:NaN`), so give `check-in` only to routes that have it.

The per-event limit is shared by everyone at the event: it holds back a script that spreads over many addresses, and it also lets one
script use up the door's budget. On a route behind `authenticate()` that only staff reach, use `check-in.staff` instead: its counter
belongs to one member of staff, so nobody else can use it up. Put `throttle('check-in')` or `throttle('check-in.staff')` on the route,
as the rate limiting page shows.

## Testing

Tests need a key like any other environment. A new app keeps a fixed one in `.env.test`. The test client encrypts and decrypts
cookies as the app does: `withCookie(name, value)` sends a value encrypted for that cookie, and `withUnencryptedCookie(name, value)`
sends it as it is, to prove that a forged value is ignored. `response.cookie(name)` and `assertCookie(name, value)` see the
decrypted value. The [HTTP tests](http-tests.md#cookies) page covers cookies in tests.
