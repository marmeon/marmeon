# A Public Page and Form

## Introduction

This recipe adds a guestbook to an app made from the [starter kit](starter-kit.md): a public page that lists the entries a
moderator approved, a form on it that any guest may send, and a page for one approved entry. Nobody signs in, so the routes say
`everyone` and the code has to be careful instead. It protects against these mistakes:

- **A script that fills the table or guesses.** The route that saves an entry carries `throttle('guestbook')`: five entries a
  minute and twenty a day per client address, then a `429`. Without it `marmeon check` warns.
- **A binding that makes every record public.** The page of one entry binds `:entry` with `{ public: true }`, and that is only
  right because `ApprovedEntries` finds approved entries and nothing else. An entry that nobody approved answers `404`, exactly as
  an id that does not exist does, so the answer tells a guest nothing about what is waiting for approval.
- **Script in a guest's text.** Every value is shown as text, which React escapes. Nothing in the module sets HTML.
- **Forged forms.** The routes sit in the `web` group, so a form sent from another site is refused before the controller runs.
  There is no `csrfExcept`.
- **Taking over a column.** The request's schema lists the two fields the form may send, and the controller writes only those two. An
  `approved_at` in the form never reaches the table, so a guest can not approve their own entry.
- **Private data on a public list.** The list reads `id`, `name`, `message` and `created_at`, and the page gets nothing more. The
  form asks for no e-mail address, and the limiter keeps the client's address only for the minute or the day it counts.

The generated code is the start; the parts that decide these things are the ones written by hand below. Approving entries
belongs to an admin area and is not part of this recipe: until something sets `approved_at`, no entry is shown.

## Generate

```sh
pnpm marmeon make:module guestbook
pnpm marmeon make:migration create_guestbook_entries_table --module=guestbook
pnpm marmeon make:controller ListGuestbookEntries --module=guestbook --request --view
pnpm marmeon make:controller StoreGuestbookEntry --module=guestbook --request
pnpm marmeon make:controller ShowGuestbookEntry --module=guestbook --view
pnpm marmeon make:test guestbook --module=guestbook --path=/guestbook
```

`make:module` writes the module and adds it to `modules` in `bootstrap/app.ts`. `make:migration` writes the migration with the
current time in its file name, so yours has another name than the one below; put the code below into your file.
`make:controller` writes the three controllers, with a page for the list and the entry and a request for the list and the form,
and `make:test` the test, which stays red until the code below replaces it. Do not migrate yet: the table is still the
generator's stub until you have replaced the files.

There is no generator for the repository, the binder `ApprovedEntries` or the service provider that defines the limiter. The
sections below show them as the pages on [routing](routing.md#a-binding-everyone-may-use) and
[rate limiting](rate-limiting.md#defining-limiters) show them.

## What it writes

| File | Purpose |
| --- | --- |
| `modules/guestbook/index.ts` | The module: its migrations, its provider and its routes. |
| `modules/guestbook/routes.ts` | The three routes, all for `everyone`; the one that saves is throttled, the one that shows an entry binds it publicly. |
| `modules/guestbook/GuestbookServiceProvider.ts` | Defines the limiter `guestbook`: five a minute and twenty a day per client. |
| `modules/guestbook/migrations/<timestamp>_create_guestbook_entries_table.ts` | The table: a UUIDv7 key, `name`, `message`, a nullable `approved_at` and the timestamps. |
| `modules/guestbook/GuestbookRepository.ts` | The queries; `approvedPage()` reads one page of the approved entries. |
| `modules/guestbook/ApprovedEntries.ts` | The binder of `:entry`: an approved entry or nothing. |
| `modules/guestbook/controllers/ListGuestbookEntriesController.ts` | The approved entries, twenty to a page. |
| `modules/guestbook/controllers/StoreGuestbookEntryController.ts` | Saves an entry that nobody approved and sends the guest back. |
| `modules/guestbook/controllers/ShowGuestbookEntryController.ts` | One approved entry. |
| `modules/guestbook/views/ListGuestbookEntries.tsx` | The list page, with the form and the pagination. |
| `modules/guestbook/views/ShowGuestbookEntry.tsx` | The page of one entry. |
| `modules/guestbook/guestbook.test.ts` | The tests of the module. |

## The code

The routes come first. The comment on `authorize(everyone)` says why no check is needed: nothing in the module acts on a user.
The route that saves has `throttle('guestbook')` in front of it, and the route that shows one entry says
`{ public: true }` on its binding.

```ts title="modules/guestbook/routes.ts"
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { ApprovedEntries } from './ApprovedEntries.ts';
import { ListGuestbookEntriesController } from './controllers/ListGuestbookEntriesController.ts';
import { ShowGuestbookEntryController } from './controllers/ShowGuestbookEntryController.ts';
import { StoreGuestbookEntryController } from './controllers/StoreGuestbookEntryController.ts';

export default defineRoutes((Route) => {
  // Guests read approved entries and leave one; nothing here acts on a user.
  const guests = Route.prefix('/guestbook').authorize(everyone).name('guestbook.');
  guests.get('/', ListGuestbookEntriesController).name('index');
  guests.middleware(throttle('guestbook')).post('/', StoreGuestbookEntryController).name('store');
  // ApprovedEntries finds approved entries only, so every visitor may read what it finds.
  guests.bind('entry', ApprovedEntries, { public: true }).get('/:entry', ShowGuestbookEntryController).name('show');
});
```

The limiter is defined in the module's service provider, as [rate limiting](rate-limiting.md#defining-limiters) describes. The
limits are counted per client address, with `clientKey()`. A limit without `.by()` would be one counter for every client, and one
script would lock all other guests out. Behind a proxy the address is the client's only when the proxy is in `TRUSTED_PROXIES`;
otherwise every guest shares one budget. See [the client's address](requests.md#the-clients-address).

```ts title="modules/guestbook/GuestbookServiceProvider.ts"
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';

export class GuestbookServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // Five entries a minute and twenty a day per client address: enough for a person, too few for a script.
    app.container.make(RateLimiter).for('guestbook', (ctx) => {
      const key = clientKey(ctx.ip);
      return [Limit.perMinute(5).by(key), Limit.perDay(20).by(key)];
    });
  }
}
```

`make:module` writes the module's `index.ts` without providers, so the module's entry lists it in `providers`:

```ts title="modules/guestbook/index.ts"
import { defineModule } from '@marmeon/core';
import { GuestbookServiceProvider } from './GuestbookServiceProvider.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'guestbook',
  migrations: new URL('./migrations/', import.meta.url),
  providers: [GuestbookServiceProvider],
  routes,
});
```

The table keeps `approved_at` empty until somebody approves the entry. The key is a UUID, so an address in the URL can not be
guessed from the one before it.

```ts title="modules/guestbook/migrations/2026_10_14_000000_create_guestbook_entries_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('guestbook_entries', (table) => {
      // A UUIDv7 as the primary key: the id is in URLs, and the next one cannot be guessed.
      table.uuidId();
      table.string('name', 60);
      table.string('message', 500);
      // Empty until somebody approves the entry; only approved entries are shown.
      table.timestamp('approved_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('guestbook_entries'),
});
```

The repository reads the approved entries and selects only the columns the page shows.

```ts title="modules/guestbook/GuestbookRepository.ts"
import { Repository, type PageRequest } from '@marmeon/database';

export class GuestbookRepository extends Repository<'guestbook_entries'> {
  static table = 'guestbook_entries' as const;

  /** One page of the approved entries, the newest first. Only what the page shows. */
  approvedPage(page: PageRequest) {
    const query = this.query()
      .select(['id', 'name', 'message', 'created_at'])
      .where('approved_at', 'is not', null)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
```

`ApprovedEntries` is the reason `{ public: true }` is safe here. A binding that finds any record by its key and is marked public
would show the whole table to anyone who tries ids. This one hands the route an entry only when `approved_at` is set.
`findByRouteKey()` looks the entry up as a repository binds it, and a value that is no UUID finds nothing without a query:

```ts title="modules/guestbook/ApprovedEntries.ts"
import type { Row } from '@marmeon/database';
import type { RouteBinder } from '@marmeon/http';
import { GuestbookRepository } from './GuestbookRepository.ts';

/** `/guestbook/:entry` — an approved entry by its id. An entry nobody approved is a 404, like an id that does not exist. */
export class ApprovedEntries implements RouteBinder<Row<'guestbook_entries'>> {
  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    this.#entries = entries;
  }

  async resolveRouteBinding(id: string) {
    const entry = await this.#entries.findByRouteKey(id);
    return entry?.approved_at ? entry : undefined;
  }
}
```

The request validates what the form sends, and the controller writes the two fields it names. It answers every valid form
alike: it does not look at who else has written, and nothing in the answer depends on other guests.

```ts title="modules/guestbook/controllers/StoreGuestbookEntryController.ts"
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { GuestbookRepository } from '../GuestbookRepository.ts';

export const StoreGuestbookEntryRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(60),
    message: r.string().trim().required().max(500),
  }),
});

/** Saves an entry that nobody has approved yet. Every valid form gets the same answer. */
export class StoreGuestbookEntryController extends Controller {
  static request = StoreGuestbookEntryRequest;

  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    super();
    this.#entries = entries;
  }

  async handle(ctx: ContextOf<typeof StoreGuestbookEntryRequest>) {
    await this.#entries.insert({ name: ctx.body.name, message: ctx.body.message });
    return this.redirect().route('guestbook.index').flash('toast', { kind: 'success', message: 'Thank you. Your entry appears once it has been approved.' });
  }
}
```

The list asks for a page, and the show controller passes on the four fields of the entry and nothing else:

```ts title="modules/guestbook/controllers/ListGuestbookEntriesController.ts"
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { GuestbookRepository } from '../GuestbookRepository.ts';

export const ListGuestbookEntriesRequest = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 20 }) }),
});

/** The approved entries, twenty to a page, and the form for a new one. */
export class ListGuestbookEntriesController extends Controller {
  static request = ListGuestbookEntriesRequest;

  readonly #entries: GuestbookRepository;

  constructor(entries: GuestbookRepository) {
    super();
    this.#entries = entries;
  }

  async handle(ctx: ContextOf<typeof ListGuestbookEntriesRequest>) {
    return this.view('guestbook/ListGuestbookEntries', { entries: await this.#entries.approvedPage(ctx.query) });
  }
}
```

```ts title="modules/guestbook/controllers/ShowGuestbookEntryController.ts"
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

/** One approved entry. `entry` is bound by the route: an entry nobody approved never gets here — it is a 404. */
export class ShowGuestbookEntryController extends Controller {
  handle(ctx: HttpContext<{}, { entry: Row<'guestbook_entries'> }>) {
    const { id, name, message, created_at } = ctx.params.entry;
    return this.view('guestbook/ShowGuestbookEntry', { entry: { id, name, message, created_at } });
  }
}
```

The pages print the guest's words with `{entry.message}`. The form is a `<Form>` of the route `guestbook.store`, which sends the
CSRF header by itself and works without JavaScript too.

```tsx title="modules/guestbook/views/ListGuestbookEntries.tsx"
import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, Pagination } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ListGuestbookEntriesController } from '../controllers/ListGuestbookEntriesController.ts';

type Props = PageProps<ListGuestbookEntriesController>;

// Every value is rendered as text: React escapes it, so a message with markup shows the markup and never runs it.
export default function ListGuestbookEntries({ entries }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="Guestbook" />
      <h1>Guestbook</h1>
      <section className="card">
        <Form route="guestbook.store" className="stack">
          {(form) => (
            <>
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input id="name" maxLength={60} {...form.field('name')} />
                {form.error('name') && <small role="alert">{form.error('name')}</small>}
              </div>
              <div className="field">
                <label htmlFor="message">Your message</label>
                <textarea id="message" rows={4} maxLength={500} {...form.field('message')} />
                {form.error('message') && <small role="alert">{form.error('message')}</small>}
              </div>
              <button type="submit" className="button" disabled={form.processing}>
                Sign the guestbook
              </button>
            </>
          )}
        </Form>
      </section>
      {entries.data.length === 0 && <p className="muted">Nobody has signed yet.</p>}
      <div className="stack">
        {entries.data.map((entry) => (
          <article key={entry.id} className="card">
            <h2>
              <Link route="guestbook.show" params={{ entry: entry.id }}>
                {entry.name}
              </Link>
            </h2>
            <p>{entry.message}</p>
          </article>
        ))}
      </div>
      <Pagination meta={entries.meta} labels={{ navigation: 'Pages of entries', previous: 'Previous', next: 'Next', page: (page) => `Page ${page}` }} />
    </main>
  );
}

ListGuestbookEntries.layout = AppLayout;
```

```tsx title="modules/guestbook/views/ShowGuestbookEntry.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ShowGuestbookEntryController } from '../controllers/ShowGuestbookEntryController.ts';

type Props = PageProps<ShowGuestbookEntryController>;

export default function ShowGuestbookEntry({ entry }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title={entry.name} />
      <article className="card">
        <h1>{entry.name}</h1>
        <p>{entry.message}</p>
      </article>
      <Link route="guestbook.index" className="button-secondary">
        Back to the guestbook
      </Link>
    </main>
  );
}

ShowGuestbookEntry.layout = AppLayout;
```

Once the code above is in place, create the table, write its columns into the app's types, and write the types of the new
routes, so the pages and `Link` know them:

```sh
pnpm marmeon migrate
pnpm marmeon db:types
pnpm marmeon route:types
```

## The test

Each test names one of the dangers above, and the file is the whole of it. A guest sees approved entries only. A form saves an
entry that nobody approved, whatever the form says about `approved_at`. An entry nobody approved answers `404`, like an id that
does not exist and one that is no UUID. The sixth entry of a minute from one client gets a `429`, and so does the twenty-first of a day, however slowly they came. A form from another site gets a
`403`, and a script that sends neither of the browser's headers gets a `419`. A message with a `<script>` tag appears in the markup as text.

```ts title="modules/guestbook/guestbook.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ListGuestbookEntriesController } from './controllers/ListGuestbookEntriesController.ts';
import { GuestbookRepository } from './GuestbookRepository.ts';

// What a guest may read and send, and what stops a script.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const entries = () => app.make(GuestbookRepository);
const approved = () => new Date().toISOString();

describe('the guestbook', { timeout: 30_000 }, () => {
  it('shows a guest the approved entries and nothing else', async () => {
    await entries().insert({ name: 'Ada', message: 'Lovely page', approved_at: approved() });
    await entries().insert({ name: 'Spammer', message: 'Buy now', approved_at: null });

    await app.navigating().get('/guestbook').assertPage<ListGuestbookEntriesController>('guestbook/ListGuestbookEntries', (props) => {
      expect(props.entries.data.map((entry) => entry.name)).toEqual(['Ada']);
      expect(props.entries.data[0]).not.toHaveProperty('approved_at');
    });
  });

  it('saves what a guest sends as an entry nobody approved, and sends the guest back', async () => {
    await app.post('/guestbook', { form: { name: '  Ada ', message: 'Hello', approved_at: approved() } }).assertRedirect('/guestbook');
    expect(await entries().findBy('name', 'Ada')).toMatchObject({ message: 'Hello', approved_at: null });
    // The entry is not on the page until somebody approves it.
    await app.navigating().get('/guestbook').assertPage<ListGuestbookEntriesController>('guestbook/ListGuestbookEntries', (props) => {
      expect(props.entries.data).toEqual([]);
    });
  });

  it('refuses a missing or a too long name and message', async () => {
    await app.post('/guestbook', { form: { name: ' ', message: 'Hello' } }).assertRedirect().assertInvalid(['name']);
    await app.post('/guestbook', { form: { name: 'x'.repeat(61), message: 'Hello' } }).assertRedirect().assertInvalid(['name']);
    await app.post('/guestbook', { form: { name: 'Ada', message: '' } }).assertRedirect().assertInvalid(['message']);
    await app.post('/guestbook', { form: { name: 'Ada', message: 'x'.repeat(501) } }).assertRedirect().assertInvalid(['message']);
    expect(await entries().count()).toBe(0);
  });

  it('opens an approved entry to everyone and answers 404 for any other', async () => {
    const shown = await entries().insert({ name: 'Ada', message: 'Lovely page', approved_at: approved() });
    const hidden = await entries().insert({ name: 'Spammer', message: 'Buy now', approved_at: null });
    await app.navigating().get(`/guestbook/${shown.id}`).assertPage('guestbook/ShowGuestbookEntry', { entry: { id: shown.id, name: 'Ada', message: 'Lovely page', created_at: shown.created_at } });
    // An entry nobody approved answers like an id that does not exist.
    await app.get(`/guestbook/${hidden.id}`).assertNotFound();
    await app.get('/guestbook/c0a80101-0000-7000-8000-000000000000').assertNotFound();
    await app.get('/guestbook/no-such-id').assertNotFound();
  });

  it('answers the sixth entry of a minute from one client with 429', async () => {
    const send = () => app.post('/guestbook', { form: { name: 'Bot', message: 'Hello' } });
    for (let attempt = 1; attempt <= 5; attempt++) (await send()).assertRedirect('/guestbook');
    (await send()).assertStatus(429);
    expect(await entries().count()).toBe(5);
    // The next minute opens a new window.
    app.travel({ seconds: 61 });
    (await send()).assertRedirect('/guestbook');
  });

  it('answers the twenty-first entry of a day with 429, however slowly they came', async () => {
    const send = () => app.post('/guestbook', { form: { name: 'Bot', message: 'Hello' } });
    for (let attempt = 1; attempt <= 20; attempt++) {
      (await send()).assertRedirect('/guestbook');
      if (attempt % 5 === 0) app.travel({ seconds: 61 });
    }
    (await send()).assertStatus(429);
    expect(await entries().count()).toBe(20);
  });

  it('refuses a form sent from another site', async () => {
    await app.close(); // one database app per test
    const protectedApp = await createTestApp(application, { csrf: true, database: 'refresh' });
    const form = { name: 'Ada', message: 'Hello' };
    await protectedApp.post('/guestbook', { form, headers: { 'sec-fetch-site': 'cross-site' } }).assertStatus(403);
    await protectedApp.post('/guestbook', { form, headers: { origin: 'https://evil.example' } }).assertStatus(403);
    // Neither header, as a script sends it: a guest has no token, so the answer is 419.
    await protectedApp.post('/guestbook', { form }).assertStatus(419);
    await protectedApp.post('/guestbook', { form, headers: { 'sec-fetch-site': 'same-origin' } }).assertRedirect('/guestbook');
    expect(await protectedApp.make(GuestbookRepository).count()).toBe(1);
  });

  it('shows the markup of a message as text', async () => {
    await app.close(); // one database app per test
    const rendering = await createTestApp(application, { database: 'refresh', ssr: true });
    await rendering.make(GuestbookRepository).insert({ name: 'Mallory', message: '<script>alert(1)</script>', approved_at: approved() });
    await rendering
      .get('/guestbook', { headers: { accept: 'text/html' } })
      .assertOk()
      .assertServerRendered()
      .assertSee('&lt;script&gt;alert(1)&lt;/script&gt;')
      .assertDontSee('<script>alert(1)');
    await rendering.close();
  });
});
```

Run the module's tests:

```sh
pnpm test modules/guestbook
```

The last test renders the page on the server, which starts Vite and takes a moment. The tests of the others use the page
object only. See [HTTP tests](http-tests.md) and [testing pages](testing-pages.md#server-rendering) for the helpers.

## Check

```sh
pnpm marmeon check
pnpm marmeon route:list
```

`marmeon check` finds what this recipe is built to avoid. `throttle` warns about a route that anyone may call to change something
and nothing limits. Without `throttle('guestbook')` on the route that saves, it prints:

```text
! throttle — 1 warning
  modules/guestbook/routes.ts:12  POST /guestbook (guestbook.store) can be called by anyone and nothing limits it — add `throttle('<name>')` (or `authenticate()`), or silence this with `// marmeon-check-ignore throttle: <why it needs no limit>`  (marmeon(throttle))
  docs: docs/rate-limiting.md#applying-limits-to-routes
```

`inner-html` warns when the code sets HTML from a value it does not fix; the [check](check.md#html-from-code) page describes it,
and [routes without a limit](check.md#routes-without-a-limit) the other. A route that says nothing about who may call it does not boot.

`route:list` shows the access of each route. The list and the form say `everyone`, the form's route also shows `throttle:guestbook`
among its middleware, and the route of one entry says `everyone (public: entry)`: the one place where a binding is open to every
visitor. A `public:` in this column that you did not expect is the thing to look at.

## Where to go next

- [Rate limiting](rate-limiting.md) for limits by address, by user and by hand, and for the answer a client gets.
- [Routing](routing.md#a-binding-everyone-may-use) for bindings that everyone may use.
- [CSRF protection](csrf.md) for how a form from another site is refused.
- [Validation](validation.md) for the rules of a field.
- [Authorization](authorization.md#every-route-decides) for why every route decides.
