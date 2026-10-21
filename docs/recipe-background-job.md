# A Job That Retries

## Introduction

This recipe adds a request that starts work in the background, on an app made from the [starter kit](starter-kit.md). A signed-in
user clicks "Email me my account data", the request queues a job and answers at once, and a worker loads the user and mails them
their name, their address and the day they signed up. When the mail server is down, the job waits and tries again; when it keeps
failing, it waits among the failed jobs for you. The work does not belong in the request: the user should not wait for a mail
server, and a server that is down should not turn a click into an error.

It protects against these mistakes:

- **A job that runs twice.** The queue runs a job *at least once*, so a worker that dies after the mail left and before the job
  was marked done sends it again. `job.once()` in the job records the mail as sent, under the key of `job.id`, which stays the
  same over every attempt and every retry; a second run of the same job finds the record and sends nothing. A mail that must
  never be doubled needs more than this, see [at least once](queues.md#at-least-once).
- **A user who floods their own inbox.** `throttle('account-export')` on the route that queues the job allows three requests an
  hour for each user and answers the fourth with a `429`. Without it, every click is a mail.
- **Two jobs for one wish.** The dispatch carries `unique: 'account-export:<id>'`, so a click while a job of this user still waits
  queues no second one. That keeps the queue short; it does not limit how many mails a user gets over time, which is the
  throttle's work.
- **Secrets and personal data in the queue.** The `jobs` and `failed_jobs` tables are a database. The payload holds
  `{ userId }`, and the job reads name and address when it runs; they are never stored with the job. See
  [secrets in payloads](queues.md#secrets-in-payloads) for a payload that has to carry one.
- **A mail to an address that is not the user's.** Anyone can register with another person's address. The routes sit behind
  `verified()`, so the request is refused until its owner confirmed the address. The job checks it again when it runs, because
  the account may have changed while the job waited: a new address is unconfirmed until it is confirmed. What the request
  checked, the job checks once more when it runs; that is the main lesson of this recipe.
- **A retry that can never succeed.** A job whose account is gone, or whose address is not confirmed any more, ends with
  `job.discard()`: no mail, no failed entry, no further attempts.
- **Endless retries.** `tries = 5` and `backoff = [10, 60, 300]` limit the attempts and space them out. The fifth failure
  lands in `failed_jobs`, where `queue:retry` can put it back.

## Generate

```sh
pnpm marmeon make:module account-export
pnpm marmeon make:controller ShowAccountExport --module=account-export --view
pnpm marmeon make:controller RequestAccountExport --module=account-export
pnpm marmeon make:job SendAccountExport --module=account-export
pnpm marmeon make:test account-export --module=account-export --path=/account/export
```

`make:module` writes the module and adds it to `modules` in `bootstrap/app.ts`. The first `make:controller` writes the page's
controller and its view, the second the controller that queues the job. `make:job` writes the job class
`SendAccountExportJob` with the stable name `account-export.send-account-export`, and adds it to `jobs` in the module's
`index.ts`. `make:test` writes a test that stays red until the code below replaces it.

`make:job` does not set `tries` or `backoff`: its job has the two lines as comments, and a job without them runs once and fails.
You write them yourself, as the job below shows. There is also no generator for the mail, so the recipe writes it as the
[mail](mail.md#writing-mails) page shows. Do not run `route:types` yet: it reads the routes and the views, which are still the
generator's stubs until you have replaced them.

## What it writes

| File | Purpose |
| --- | --- |
| `modules/account-export/index.ts` | The module: its job, its provider and its routes. |
| `modules/account-export/routes.ts` | The page and the request, behind `authenticate()` and `verified()`; the request is throttled. |
| `modules/account-export/AccountExportServiceProvider.ts` | Defines the limiter `account-export`: three requests an hour for each user. |
| `modules/account-export/controllers/ShowAccountExportController.ts` | The page with the button. |
| `modules/account-export/views/ShowAccountExport.tsx` | The page: a form with one button. |
| `modules/account-export/controllers/RequestAccountExportController.ts` | Queues the job for the signed-in user and sends them back to the page. |
| `modules/account-export/jobs/SendAccountExportJob.ts` | The job: loads the user, sends the mail once, retries on an error. |
| `modules/account-export/mail/AccountExportMail.ts` | The mail with name, address and the day the account was made. |
| `modules/account-export/account-export.test.ts` | The tests of the module. |

## The code

The routes come first. Both are for the signed-in user with a confirmed address, and both act on `ctx.user`, so no id comes from
the path and no record needs a policy: the comment on `authorize(everyone)` says so.

```ts title="modules/account-export/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { RequestAccountExportController } from './controllers/RequestAccountExportController.ts';
import { ShowAccountExportController } from './controllers/ShowAccountExportController.ts';

export default defineRoutes((Route) => {
  // Signed in, with a confirmed address. Both routes act on the signed-in account (`ctx.user`) and take no id from the path,
  // so there is no record to authorize.
  const account = Route.prefix('/account/export').middleware(authenticate()).middleware(verified()).authorize(everyone).name('account-export.');
  account.get('/', ShowAccountExportController).name('show');
  // Three requests an hour for each user; AccountExportServiceProvider defines the limiter.
  account.middleware(throttle('account-export')).post('/', RequestAccountExportController).name('request');
});
```

The limiter is defined in the module's service provider, as [rate limiting](rate-limiting.md#defining-limiters) describes. It
counts by the user's id, which `ctx.user` holds because `authenticate()` runs before `throttle()` on the route.

```ts title="modules/account-export/AccountExportServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class AccountExportServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // Three requests an hour for each user: every one can send a mail to their address.
    app.container.make(RateLimiter).for('account-export', (ctx) => Limit.perHour(3).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
```

The module lists the job and the provider. A worker runs only the jobs its app knows, and a dispatch of a job that no module
lists throws. `make:job` adds the class for you; `make:module` wrote the file without a `jobs` or a `providers` key, so you add
the provider yourself.

```ts title="modules/account-export/index.ts"
import { defineModule } from '@marmeon/core';
import { AccountExportServiceProvider } from './AccountExportServiceProvider.ts';
import { SendAccountExportJob } from './jobs/SendAccountExportJob.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'account-export',
  jobs: [SendAccountExportJob],
  providers: [AccountExportServiceProvider],
  routes,
});
```

The controller queues the job. Its payload is the user's id and nothing else. The `unique` key belongs to this job class and to
this user, so a click while a job of this user waits queues no second one, and another user has a key of their own. The key is freed when the job is done, failed or
discarded, and at the latest after an hour. With workers on several machines, the lock needs a cache they share,
`CACHE_DRIVER=database` or `redis`; see [unique jobs](queues.md#unique-jobs).

```ts title="modules/account-export/controllers/RequestAccountExportController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Queue } from '@marmeon/queue';
import { SendAccountExportJob } from '../jobs/SendAccountExportJob.ts';

/** Queues the mail with the signed-in user's data; a worker sends it. */
export class RequestAccountExportController extends Controller {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    super();
    this.#queue = queue;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    // The id of the signed-in user and nothing else goes into the queue. While one job of this user waits, a click queues no second one.
    await this.#queue.dispatch(SendAccountExportJob, { userId: ctx.user.id }, { unique: `account-export:${ctx.user.id}` });
    return this.redirect().route('account-export.show').flash('toast', { kind: 'success', message: 'We are sending your account data to your address.' });
  }
}
```

The job is where retrying happens. A job that throws is attempted again after its `backoff`, up to `tries` attempts in all, and
then it fails. `make:job` writes neither line, so they are added by hand: five attempts, waiting 10 seconds, a minute, then five
minutes before each further one. The job sends the mail itself with `send()`: the job already is the background part, and a
`mailer.queue()` inside it would put a second job behind it, whose retries nobody sees here. An error from the mail server
reaches the queue as the job's error, which is what makes the job retry.

```ts title="modules/account-export/jobs/SendAccountExportJob.ts"
import { Mailer } from '@marmeon/mail';
import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { AccountExportMail } from '../mail/AccountExportMail.ts';

/** Mails a user the data of their account. The payload holds the user's id; the job reads the account as it is when it runs. */
export class SendAccountExportJob {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = 'account-export.send-account-export';
  static readonly schema = r.object({ userId: r.integer() });
  // Five attempts in all. A mail server that is down for a while gets the next attempt after 10 s, 1 min, then 5 min each.
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 30;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;

  constructor(users: UserRepository, mailer: Mailer) {
    this.#users = users;
    this.#mailer = mailer;
  }

  async handle(payload: JobPayload<typeof SendAccountExportJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    // The request checked that the address is confirmed; the job checks it again, since the account may have changed since:
    // a new address is unconfirmed until its owner confirms it. No mail, and no retry that could never succeed.
    if (!user || user.email_verified_at == null) return job.discard('the account is gone or its address is not confirmed');
    // job.id stays the same over every attempt and every retry: a record that comes back after the mail went out sends nothing more.
    await job.once(`account-export:${job.id}`, () => this.#mailer.send(new AccountExportMail(user)));
  }
}
```

The first line of `handle()` after loading the user checks again that the account exists and that its address is confirmed, and
discards the job when either is not true. `job.once()` then runs the mail unless a marker for its key exists, and writes the
marker after the mail was sent. The key holds `job.id`, so a record that comes back after the mail left sends nothing and the job
still counts as done, while a later request is a new job with a key of its own and sends its mail. A worker that dies between
the mail and the marker still sends twice: `once()` makes a repeat rare, not impossible. `once()` needs `@marmeon/cache`, and with
workers on several machines a cache they share.

The mail is a class, with the data coming through the constructor. `html` escapes every value, so a name with markup is shown as
text:

```ts title="modules/account-export/mail/AccountExportMail.ts"
import { html, type Mailable } from '@marmeon/mail';
import type { User } from '#modules/auth';

/** The data of an account, to the address of the account. */
export class AccountExportMail implements Mailable {
  readonly #user: User;

  constructor(user: User) {
    this.#user = user;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: 'Your account data' };
  }

  content() {
    const { name, email } = this.#user;
    const since = new Date(this.#user.created_at).toISOString().slice(0, 10);
    return html`<p>Hello ${name},</p>
<p>This is the data we keep about your account:</p>
<ul>
  <li>Name: ${name}</li>
  <li>E-mail address: ${email}</li>
  <li>Account created: ${since}</li>
</ul>`;
  }
}
```

The page controller and the view have nothing to decide. The button is a `<Form>` of the route `account-export.request`, which
sends the CSRF header by itself.

```ts title="modules/account-export/controllers/ShowAccountExportController.ts"
import { Controller } from '@marmeon/http';

/** The page with the button that asks for the mail. */
export class ShowAccountExportController extends Controller {
  handle() {
    return this.view('account-export/ShowAccountExport', {});
  }
}
```

```tsx title="modules/account-export/views/ShowAccountExport.tsx"
import type { PageProps } from '@marmeon/http';
import { Form, Head } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ShowAccountExportController } from '../controllers/ShowAccountExportController.ts';

type Props = PageProps<ShowAccountExportController>;

export default function ShowAccountExport(_props: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="Your account data" />
      <h1>Your account data</h1>
      <section className="card">
        <p>We send your name, your e-mail address and the day you signed up to the address of your account.</p>
        <Form route="account-export.request" className="stack">
          {(form) => (
            <button type="submit" className="button" disabled={form.processing}>
              Email me my account data
            </button>
          )}
        </Form>
      </section>
    </main>
  );
}

ShowAccountExport.layout = AppLayout;
```

Once the code above is in place, write the types of the new routes, so the page and `Link` know them:

```sh
pnpm marmeon route:types
```

## The test

Each test names one of the dangers above, and the file is the whole of it. A guest is sent to the sign-in page, and so is an
account whose address nobody confirmed; neither queues anything. A request queues one job whose payload is the user's id, with
neither address nor name in it, and a second click queues none. When the job runs, exactly one mail goes to the user. The fourth
request of an hour from one user gets a `429`, and another user is not affected. A job record that comes back after its mail went
out, on the real database queue, sends nothing more. A job whose account is gone, or whose address was unconfirmed after the
request, ends without a mail, a failure or another attempt. The last test reads the job's row: `tries` and `backoff` are
stored with it.

The tests do not make the mail server fail. The retries themselves are the queue's own work, and the
[queues](queues.md#retries-and-failures) page and the [fakes](fakes.md#queue) page show how to run them: `app.queue.work()` runs
the jobs that are due, and `app.travel()` moves the clock to the next attempt.

```ts title="modules/account-export/account-export.test.ts"
import { UserFactory, UserRepository } from '#modules/auth';
import { Connections, sql } from '@marmeon/database';
import { QueueConnections } from '@marmeon/queue';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendAccountExportJob } from './jobs/SendAccountExportJob.ts';
import { AccountExportMail } from './mail/AccountExportMail.ts';

// What a request for the mail queues, what the job sends, and what happens when it runs twice or fails.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

describe('the account export', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page and queues nothing', async () => {
    await app.get('/account/export').assertRedirect('/login');
    await app.post('/account/export').assertRedirect('/login');
    app.queue.assertNothingDispatched();
  });

  it('queues nothing for an account whose address nobody has confirmed', async () => {
    // Anyone can register with another person's address; the mail must not reach it before its owner confirmed it.
    const mallory = await app.factory(UserFactory).state('unverified').create();
    await app.actingAs(mallory).post('/account/export').assertRedirect('/email/verify');
    app.queue.assertNothingDispatched();
  });

  it('queues a job with the id of the signed-in user and nothing else in its payload', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/account/export').assertPage('account-export/ShowAccountExport', {});
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');

    app.queue.assertDispatchedTimes(SendAccountExportJob, 1);
    const [dispatched] = app.queue.dispatched(SendAccountExportJob);
    expect(dispatched!.payload).toEqual({ userId: ada.id });
    // The payload is stored with the job: no address, no name.
    expect(JSON.stringify(dispatched!.payload)).not.toContain(ada.email);
    expect(JSON.stringify(dispatched!.payload)).not.toContain(ada.name);
  });

  it('queues no second job while the first one waits', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    app.queue.assertDispatchedTimes(SendAccountExportJob, 1);

    // Another account has a key of its own.
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(bob).post('/account/export').assertRedirect('/account/export');
    app.queue.assertDispatchedTimes(SendAccountExportJob, 2);
  });

  it('mails the user once, with name, address and the day the account was made', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    app.mail.assertNotSent(AccountExportMail);

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
    app.mail.assertSentCount(AccountExportMail, 1);
    const [sent] = app.mail.sent(AccountExportMail);
    expect(sent!.message.to).toEqual([{ address: ada.email, name: ada.name }]);
    expect(sent!.message.text).toContain(ada.email);
    expect(sent!.message.text).toContain(new Date(ada.created_at).toISOString().slice(0, 10));
  });

  it('answers the fourth request of an hour from one user with 429, and leaves other users alone', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    for (let attempt = 1; attempt <= 3; attempt++) await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.actingAs(ada).post('/account/export').assertStatus(429);
    await app.actingAs(bob).post('/account/export').assertRedirect('/account/export');
    // The next hour opens a new window.
    app.travel({ seconds: 3601 });
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
  });

  it('sends nothing more when the same job comes back after the mail went out', async () => {
    await app.close(); // one database app per test
    const real = await createTestApp(application, { database: 'refresh', queue: 'real' });
    const ada = await real.factory(UserFactory).create();
    await real.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    const db = real.make(Connections).get();
    const { rows } = await sql<{ queue: string; payload: string; available_at: number; created_at: number }>`select queue, payload, available_at, created_at from jobs`.execute(db);
    const work = () => real.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });

    expect(await work()).toMatchObject({ processed: 1, failed: 0 });
    real.mail.assertSentCount(AccountExportMail, 1);
    // A worker that died after the mail and before it marked the job done leaves the record in the table: the same record,
    // with the same job id, is back.
    const [job] = rows;
    await sql`insert into jobs (queue, payload, attempts, available_at, created_at) values (${job!.queue}, ${job!.payload}, 0, ${job!.available_at}, ${job!.created_at})`.execute(db);
    expect(await work()).toMatchObject({ processed: 1, failed: 0 });
    real.mail.assertSentCount(AccountExportMail, 1);
    await real.close();
  });

  it('sends no mail when the address stopped being confirmed after the request', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    // A new address is unconfirmed until its owner confirms it.
    await sql`update users set email_verified_at = null where id = ${ada.id}`.execute(app.make(Connections).get());

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0, released: 0 });
    app.mail.assertNothingSent();
    expect(await app.queue.failed()).toEqual([]);
    expect(app.queue.pending()).toEqual([]);
  });

  it('ends without a mail, a failure or a retry when the account is gone by the time the job runs', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.make(UserRepository).delete(ada.id);

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0, released: 0 });
    app.mail.assertNothingSent();
    expect(await app.queue.failed()).toEqual([]);
    // A job that threw would wait here for its next attempt.
    expect(app.queue.pending()).toEqual([]);
  });

  it('stores five tries and the waits between them with the job', async () => {
    await app.close(); // one database app per test
    const real = await createTestApp(application, { database: 'refresh', queue: 'real' });
    const ada = await real.factory(UserFactory).create();
    await real.actingAs(ada).post('/account/export').assertRedirect('/account/export');

    await real.assertDatabaseHas('jobs', { queue: 'default', attempts: 0 });
    const { rows } = await sql<{ payload: string }>`select payload from jobs`.execute(real.make(Connections).get());
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ job: 'account-export.send-account-export', data: { userId: ada.id }, tries: 5, backoff: [10, 60, 300] });
    await real.close();
  });
});
```

Run the module's tests:

```sh
pnpm test modules/account-export
```

## Check

```sh
pnpm marmeon check
pnpm marmeon route:list
```

`marmeon check` finds what this recipe is built to avoid. `modules` warns about a job class under `modules/` that no module lists:
a job nobody registered would be queued and never run. `throttle` warns about a route that anyone may call to change something
and nothing limits; the request is not reported because `authenticate()` declares that it only lets signed-in users through. The
[check](check.md#the-app-checks) page lists the others.

`route:list` shows the access of each route. Both routes say `everyone`, with `authenticate` and `verified` among their
middleware, and the request also shows `throttle:account-export`: the decision to leave the check to the middleware is made in
`routes.ts`, and the list is where to see that no other route of the module took it by accident.

`marmeon dev` starts a worker for you, so in development a click sends its mail to the log at once. On a server, and wherever you
run the app without `marmeon dev`, start the worker yourself with `pnpm marmeon queue:work`. Then watch the failed jobs:

- `queue:failed` lists the jobs that used up their tries, newest first, with their ids and the error.
- `queue:retry <id>` (or `all`) puts a failed job back on its queue with its attempts from zero.
- `queue:forget <id>` deletes one failed entry, and `queue:prune-failed` deletes the old ones.

The [queues](queues.md#retries-and-failures) page has them all, and what a worker does with a job it cannot read after a deploy.

## Where to go next

- [Queues](queues.md) for the promises of the queue, job middleware, chains and workers.
- [Mail](mail.md#sending-mails) for queueing a mail instead of sending it from a job of your own.
- [Fakes](fakes.md#queue) for the assertions of the queue and the mail fake.
- [Rate limiting](rate-limiting.md) when a route should count its calls as well.
- [Secrets in payloads](queues.md#secrets-in-payloads) for a job that has to carry one.
