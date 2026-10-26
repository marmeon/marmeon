# Time

## Introduction

Tests often need time to pass: a rate limit to reset, a link to expire, a nightly task to come due. Every test app has a test
clock as the app's `Clock`, and the test moves it instead of waiting:

```ts title="modules/auth/sign-in-throttle.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

it('lets a user try again a minute after five failed sign-ins', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const signIn = (password: string) => app.post('/login', { form: { email: ada.email, password } });

  app.freeze();
  for (let attempt = 0; attempt < 5; attempt++) await signIn('wrong');
  await signIn('password').assertInvalid({ email: /^Too many login attempts/ }).assertGuest();

  app.travel({ seconds: 61 });
  await signIn('password').assertRedirect('/dashboard').assertAuthenticated(ada);
});
```

No timer is faked and nothing sleeps. The rate limiter reads the time through the app's clock, so it sees the minute pass.

## Moving the clock

| Method | What it does |
| --- | --- |
| `app.freeze(time)` | Stops the clock, at `time` when given, else now. Returns the frozen time in milliseconds. |
| `app.travel(duration)` | Moves the clock by a duration: seconds as a number (`app.travel(90)`), or an object such as `{ minutes: 61 }`. Negative values move it back. |
| `app.travelTo(time)` | Jumps to a `Date` or epoch milliseconds. |
| `app.clock.unfreeze()` | Lets the clock run again from where it stands. |
| `app.clock.now()` | The app's time in milliseconds, as the app's services read it. |

A clock that is not frozen runs with the real time, plus the distance you travelled. A frozen clock stands still until the next
`travel()` or `travelTo()`, which moves it and leaves it frozen. Freeze it when a test compares exact times:

```ts title="modules/notes/clock.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('moves a frozen clock by exactly the duration', async () => {
  const app = await createTestApp(application);
  const start = app.freeze(Date.parse('2026-10-04T12:00:00Z'));
  app.travel({ hours: 1, seconds: 30 });
  expect(app.clock.now()).toBe(start + 3_630_000);
});
```

A number means seconds (`app.travel(90)`); an object takes `days`, `hours`, `minutes`, `seconds` and `milliseconds`. Each test app has its own clock, so one test's travel
never reaches another test.

## Spans of time

`Duration` from `@marmeon/core` is the one type for a span of time. It is a number of seconds, or an object with the parts
`days`, `hours`, `minutes`, `seconds` and `milliseconds`: `90`, `{ minutes: 5 }`, `{ hours: 1, seconds: 30 }`. A `Temporal.Duration`
fits too. There are no strings: `'60m'` is a `TypeError` that names the object to write, `{ minutes: 60 }`, so a typo never turns into
a link without an expiry. The parts `years`, `months` and `weeks` are refused as well, because their length depends on the calendar, and so are `microseconds` and `nanoseconds`, which a millisecond clock cannot keep.
`durationToSeconds(duration)` and `durationToMilliseconds(duration)` turn one into a number, and refuse anything else.

Five rules say where a span is a `Duration`:

1. An option or a parameter that takes a span and has no unit in its name is a `Duration`: `delay`, `release()`, `expiresIn`,
   `uniqueFor`, the `ttl` of the cache, `lock()` and `block()` of a lock, the window of a `Limit`, and `Route.block()`.
2. A number with a unit in its name stays a number: `keepAliveTimeoutMs`, `SESSION_MAX_SECONDS`, a measured `durationMs`.
3. A name without a unit never holds a bare number that means something else than seconds. A `Duration` is seconds when it is a number.
4. A contract that your app implements, such as a cache store or a lock store, gets normalised numbers with the unit in the name,
   never a `Duration`.
5. What the framework returns or lays out for you to read, such as a return value, a field of a resolved config, the context of a
   middleware or a field of an event, is a normalised number with the unit in its name: `retryAfterSeconds`, `sessionMaxSeconds`.
   A `Duration` is an input only.

A span in a position of a parameter is a `Duration`, or it moves into an options object; the unit in a parameter name would never
show at the call.

An expiry is rounded down to a whole second, so a link or a token never lives longer than you asked: `{ seconds: 1, milliseconds: 900 }`
expires after one second. A `Limit` takes only whole seconds, because its window is part of the key its count is stored under.

## What follows the clock

Everything that reads the time through the app's `Clock` follows the test clock:

- the cache's expiry, locks and rate limits on the `memory`, `file` and `database` drivers;
- the session's lifetime and its expiry on the server;
- signed URLs and temporary links to files;
- password reset tokens, remember-me tokens and API tokens;
- the sign-in: its absolute lifetime, the window of a password confirmation (`confirmedPassword()`), the proof of a second
  factor (`twoFactor()`, `confirmedSecondFactor()`) and the cap of a remember-me cookie (`AUTH_REMEMBER_DAYS`), and how long a started second-factor step stays open;
- the delays and backoffs of queued jobs, which `app.queue.work()` runs once they are due;
- the scheduler, through `app.schedule`;
- the cached answer of the readiness check.

Your own services follow it when they take a `Clock` through the constructor instead of calling `Date.now()`. The
[context](context.md#the-clock) page shows how.

## What does not follow it

Some time is not the app's to move:

- **Redis** keeps its own clock. A cache entry, a lock or a rate limit on the `redis` driver expires when Redis says so,
  whatever the test clock reads. Tests that travel use the `memory` driver, which `.env.test` sets.
- **The database** has its own clock too. A column default such as `current_timestamp`, or `now()` in a query, is the database
  server's time.
- **`Date.now()` and `new Date()`** in your code read the real time. Inject a `Clock` where a test must move the time.
- **Timers** such as `setTimeout()` wait in real time. A job's timeout and a lock's wait are real waits.

## A job that waits

A job dispatched with a `delay` waits on the queue fake until the clock reaches it. `work()` runs only what is due:

```ts title="modules/billing/reminders.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';

it('sends the reminder five minutes later', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).post('/billing/reminders').assertRedirect();
  app.queue.assertDispatched(SendInvoiceReminderJob, (_payload, job) => job.delaySeconds === 300);

  expect(await app.queue.work()).toMatchObject({ processed: 0 });
  app.travel({ minutes: 5 });
  expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
});
```

A job that is released with a backoff waits the same way, so a test of its retries travels between two calls of `work()`. The
[fakes](fakes.md#queue) page covers the queue fake.

## The schedule and the clock

`app.schedule.run(time)` moves the clock to `time` before it runs what is due, so a task sees the minute it runs in. A second
`run()` later catches up what was missed between the two, as the scheduler does after a pause. The [fakes](fakes.md#the-schedule)
page shows a test.
