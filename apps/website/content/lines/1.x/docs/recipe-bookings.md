# Bookings That Never Overlap

## Introduction

This recipe adds a room booking to an app made from the [starter kit](starter-kit.md): a signed-in user picks a room and a
period, and the room is theirs unless somebody holds it for any part of that time. The rule sounds like one `if`, and it is the
kind of rule that breaks only under load: two people book the same room for the same hour at the same moment, and both are
told yes.

It protects against these mistakes:

- **Check, then insert.** The code looks for a booking in the way, finds none, and inserts. On SQLite that is safe inside a
  [transaction](transactions.md), because SQLite lets one writer at a time through (inside one process). On Postgres it is not: under the default
  isolation level (`READ COMMITTED`) two transactions can both run the check before either has inserted, both find the room
  free, and both insert. Nothing in the second transaction notices the first, because the first has not committed.
- **A rule that only the application knows.** Any other writer, such as a script, an import or a second app on the same
  database, skips the check. On Postgres the rule belongs in the database: an *exclusion constraint* refuses a row whose room
  and period collide with another row, whoever inserts it and however many requests race.
- **A raw database error on the page.** The refusal comes from the database as an error, not as a unique violation, so
  `tryInsert()` and `failOnDuplicate()` do not recognise it. The repository turns it into an `err`, and the controller turns that
  into a message at the form's field.
- **Bookings that "touch".** A period is half-open: it holds the room from its start up to, but not including, its end. A
  meeting that ends at 10:00 and one that starts at 10:00 do not collide.
- **A booking that ends before it starts**, and a room that does not exist, are refused before the database is asked.

The recipe uses the exclusion constraint on Postgres and the transaction on SQLite, in one repository method. The
[other ways](#other-ways-on-postgres) section says when a lock or a stricter isolation level is the better tool.

## Generate

```sh
pnpm marmeon make:module bookings
pnpm marmeon make:migration create_rooms_table --module=bookings
pnpm marmeon make:migration create_bookings_table --module=bookings
pnpm marmeon make:controller ListBookings --module=bookings --view
pnpm marmeon make:controller StoreBooking --module=bookings --request
pnpm marmeon make:test bookings --module=bookings --path=/bookings
```

`make:module` writes the module and adds it to `modules` in `bootstrap/app.ts`. `make:migration` writes the two migrations with
the current time in their file names, so yours have other names than the ones below; put the code below into your files, in this
order. `make:controller` writes the controller that lists, with its page, and the one that stores, with its request, and
`make:test` writes the test, which stays red until the code below replaces it. Do not migrate yet: the migrations are still the
generator's stubs until you have replaced them.

There is no generator for the repositories. The sections below show them as the [queries](queries.md) page does.

## What it writes

| File | Purpose |
| --- | --- |
| `modules/bookings/index.ts` | The module: its migrations and its routes. |
| `modules/bookings/routes.ts` | The page and the booking, behind `authenticate()`. |
| `modules/bookings/migrations/<timestamp>_create_rooms_table.ts` | The rooms. |
| `modules/bookings/migrations/<timestamp>_create_bookings_table.ts` | The bookings, and on Postgres the exclusion constraint. |
| `modules/bookings/RoomRepository.ts` | The rooms. |
| `modules/bookings/BookingRepository.ts` | `book()`: the check, the insert, and the refusal as an `err`. |
| `modules/bookings/controllers/ListBookingsController.ts` | The rooms and the bookings that have not ended. |
| `modules/bookings/controllers/StoreBookingController.ts` | Validates the form, books, and answers at the field when the room is taken. |
| `modules/bookings/views/ListBookings.tsx` | The page: the bookings and the form. |
| `modules/bookings/bookings.test.ts` | The tests of the module. |

## The code

The module and its routes come first. Both routes are for any signed-in user and act on `ctx.user`, so no id comes from the path
and no record needs a policy; the comment on `authorize(everyone)` says so.

```ts title="modules/bookings/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'bookings',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
```

```ts title="modules/bookings/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListBookingsController } from './controllers/ListBookingsController.ts';
import { StoreBookingController } from './controllers/StoreBookingController.ts';

export default defineRoutes((Route) => {
  // Every signed-in user sees the calendar and books for themselves: the booking takes its user from `ctx.user`, so there is no
  // record to authorize.
  const bookings = Route.prefix('/bookings').middleware(authenticate()).authorize(everyone).name('bookings.');
  bookings.get('/', ListBookingsController).name('index');
  bookings.post('/', StoreBookingController).name('store');
});
```

### The tables

A room is a name. A booking holds a room for a period: two `timestamp` columns, which Postgres stores as `timestamptz` and
SQLite as an ISO-8601 string in UTC.

```ts title="modules/bookings/migrations/2026_10_23_000000_create_rooms_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('rooms', (table) => {
      table.id();
      table.string('name', 60);
      table.timestamps();
    }),
  down: (schema) => schema.drop('rooms'),
});
```

The constraint is the part the schema methods cannot say, so it is [raw SQL](migrations.md#raw-sql) for Postgres. `schema.raw()`
with only a `pgsql` statement skips the step on SQLite. `btree_gist` is an extension that ships with Postgres; the
`create extension` needs the right to do so, which the database owner has on the usual hosts. The constraint compares the rooms
with `=` and the periods with `&&` (overlap): two rows collide when both are true. An empty period overlaps nothing, and a
reversed one is an error of Postgres, so a second constraint, `bookings_period`, requires `starts_at < ends_at` of every row,
whoever inserts it. The migration API has no check constraint, so it is raw SQL as well, and Postgres only.

```ts title="modules/bookings/migrations/2026_10_23_000001_create_bookings_table.ts"
import { defineMigration, sql } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    schema.create('bookings', (table) => {
      table.id();
      table.foreignId('room_id').constrained().cascadeOnDelete();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      // The booking holds the room from `starts_at` up to, but not including, `ends_at`.
      table.timestamp('starts_at');
      table.timestamp('ends_at');
      table.timestamps();
    });
    // Postgres: the database itself refuses two bookings of one room whose periods overlap, however many requests race. The
    // half-open range lets one booking end at the minute the next one starts, and `btree_gist` lets a gist index compare
    // `room_id` with `=`. SQLite has no such constraint (the statements are skipped there): its single writer makes the check
    // in BookingRepository enough.
    schema.raw({ pgsql: sql`create extension if not exists btree_gist` });
    // An empty period overlaps nothing, so a row with `starts_at >= ends_at` has to be refused on its own.
    schema.raw({ pgsql: sql`alter table bookings add constraint bookings_period check (starts_at < ends_at)` });
    schema.raw({ pgsql: sql`alter table bookings add constraint bookings_no_overlap exclude using gist (room_id with =, tstzrange(starts_at, ends_at) with &&)` });
  },
  down: (schema) => schema.drop('bookings'),
});
```

Marmeon does not look into a raw statement, and the constraint is no part of its picture of the schema: nothing in `db:types` or
the query builder changes. What it checks is the result, and a statement that creates a constraint passes. The constraint
belongs to the table, so `down` needs no statement of its own.

### The repository

`book()` is the whole rule. The check runs first, so the usual refusal costs a `select` and no error; the transaction makes the
check and the insert one unit on SQLite. On Postgres the check is the friendly path, and the constraint is the truth: when two
transactions pass the check together, the database refuses the second insert with SQLSTATE `23P01`
(`exclusion_violation`), and the `catch` turns that error into the same `err` the check returns. It is the pattern of
[`tryInsert()`](queries.md#writing) for an index that `tryInsert()` does not know.

`book()` is a `Result`, as the data layer's expected failures are: `ok(booking)` or `err({ kind: 'overlap' })`. Any other error
is a bug or an outage and stays a throw. The transaction is a savepoint when the caller has one open, so a refused insert does not
poison the transaction around it, as [nested transactions](transactions.md#nested-transactions) explain.

Two inserts that conflict at the very same instant can also end in a deadlock: each waits for the other's row, and Postgres ends
one of them with `40P01`. That is a lost race all the same. `book()` tries once more, and the second try finds the
winner, by its check or by the constraint. A second deadlock is thrown. For this to start clean, call `book()` outside a transaction of your own, as the controller does.

```ts title="modules/bookings/BookingRepository.ts"
import { err, ok, type Result } from '@marmeon/core';
import { Repository, type Row } from '@marmeon/database';

export type BookingError = { kind: 'overlap' };

type NewBooking = { room_id: number; user_id: number; starts_at: string; ends_at: string };

/** Postgres refused a row for the exclusion constraint `bookings_no_overlap`: SQLSTATE 23P01, which is not a unique violation. */
function isOverlap(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23P01' && (error as { constraint?: unknown }).constraint === 'bookings_no_overlap';
}

/** Two inserts that conflict at the same instant can wait for each other: Postgres ends one of them with SQLSTATE 40P01. */
function isDeadlock(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '40P01';
}

export class BookingRepository extends Repository<'bookings'> {
  static table = 'bookings' as const;

  /** Whether a booking of the room overlaps `[startsAt, endsAt)`. Both are ISO strings in UTC, as the columns hold them. */
  async overlaps(roomId: number, startsAt: string, endsAt: string): Promise<boolean> {
    const row = await this.query().select('id').where('room_id', '=', roomId).where('starts_at', '<', endsAt).where('ends_at', '>', startsAt).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Books the room, or says `overlap`. On SQLite the transaction is the guard: a process has one writer, so nobody books between
   * the check and the insert (a second process that loses the race for the file fails with "database is locked" instead). On
   * Postgres two transactions can both pass the check, and the exclusion constraint refuses the second insert: the catch turns
   * that error into the same `err`. The transaction is a savepoint inside an open one, so a refused insert leaves the
   * transaction around it usable. When Postgres picks this one as the victim of a deadlock between two conflicting inserts, the
   * booking is tried once more and the second try finds the winner, by its check or by the constraint. Call it outside a
   * transaction of your own, so that the second try starts clean.
   */
  book(values: NewBooking): Promise<Result<Row<'bookings'>, BookingError>> {
    return this.#book(values, false);
  }

  async #book(values: NewBooking, retried: boolean): Promise<Result<Row<'bookings'>, BookingError>> {
    try {
      return await this.transaction(async (bookings) => {
        if (await bookings.overlaps(values.room_id, values.starts_at, values.ends_at)) return err({ kind: 'overlap' as const });
        return ok(await bookings.insert(values));
      });
    } catch (error) {
      if (isOverlap(error)) return err({ kind: 'overlap' });
      if (isDeadlock(error) && !retried) return this.#book(values, true);
      throw error;
    }
  }

  /** The bookings that have not ended, the earliest first. */
  upcoming(now: string) {
    return this.query().select(['id', 'room_id', 'starts_at', 'ends_at']).where('ends_at', '>', now).orderBy('starts_at').execute();
  }
}
```

```ts title="modules/bookings/RoomRepository.ts"
import { Repository } from '@marmeon/database';

export class RoomRepository extends Repository<'rooms'> {
  static table = 'rooms' as const;
}
```

### The controllers

The page lists the rooms and the bookings that have not ended.

```ts title="modules/bookings/controllers/ListBookingsController.ts"
import { Controller } from '@marmeon/http';
import { BookingRepository } from '../BookingRepository.ts';
import { RoomRepository } from '../RoomRepository.ts';

/** The rooms, the bookings that have not ended, and the form for a new one. */
export class ListBookingsController extends Controller {
  readonly #rooms: RoomRepository;
  readonly #bookings: BookingRepository;

  constructor(rooms: RoomRepository, bookings: BookingRepository) {
    super();
    this.#rooms = rooms;
    this.#bookings = bookings;
  }

  async handle() {
    const rooms = await this.#rooms.query().select(['id', 'name']).orderBy('name').execute();
    return this.view('bookings/ListBookings', { rooms, bookings: await this.#bookings.upcoming(new Date().toISOString()) });
  }
}
```

The store controller validates the form, then books. A refusal becomes a `ValidationError` at `starts_at`: the form goes back
with the message next to the field and the input, as for any failed schema, and a JSON client gets a `422`. A booking that
ends before it starts, and a room that does not exist, are the user's input too and are refused the same way.

```ts title="modules/bookings/controllers/StoreBookingController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { BookingRepository } from '../BookingRepository.ts';
import { RoomRepository } from '../RoomRepository.ts';

export const StoreBookingRequest = defineRequest({
  schema: r.object({
    room_id: r.integer().min(1),
    starts_at: r.isoTimestamp(),
    ends_at: r.isoTimestamp(),
  }),
});

/** Books a room for the signed-in user, or sends the form back with the reason at its field. */
export class StoreBookingController extends Controller {
  static request = StoreBookingRequest;

  readonly #rooms: RoomRepository;
  readonly #bookings: BookingRepository;

  constructor(rooms: RoomRepository, bookings: BookingRepository) {
    super();
    this.#rooms = rooms;
    this.#bookings = bookings;
  }

  async handle(ctx: ContextOf<typeof StoreBookingRequest> & Authenticated) {
    // The columns hold UTC to the millisecond, and SQLite compares them as text: normalize what the form sent.
    const starts = new Date(ctx.body.starts_at);
    const ends = new Date(ctx.body.ends_at);
    if (ends <= starts) throw new ValidationError({ ends_at: ['The booking must end after it starts.'] }, ctx.body);
    if (!(await this.#rooms.exists(ctx.body.room_id))) throw new ValidationError({ room_id: ['Choose one of the rooms.'] }, ctx.body);

    const booked = await this.#bookings.book({ room_id: ctx.body.room_id, user_id: ctx.user.id, starts_at: starts.toISOString(), ends_at: ends.toISOString() });
    if (!booked.ok) throw new ValidationError({ starts_at: ['The room is already booked for part of this time.'] }, ctx.body);
    return this.redirect().route('bookings.index').flash('toast', { kind: 'success', message: 'The room is yours.' });
  }
}
```

The page takes the times as ISO-8601 text with a zone, as `r.isoTimestamp()` does. A real app puts a date and time picker in
front and sends that format; the recipe keeps the form plain. The controller turns the times into UTC to the millisecond, the
form the columns hold, because SQLite compares them as text.

```tsx title="modules/bookings/views/ListBookings.tsx"
import type { PageProps } from '@marmeon/http';
import { Form, Head } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ListBookingsController } from '../controllers/ListBookingsController.ts';

type Props = PageProps<ListBookingsController>;

export default function ListBookings({ rooms, bookings }: Props) {
  const roomName = (id: number) => rooms.find((room) => room.id === id)?.name ?? '';
  return (
    <main className="app-main stack stack-loose">
      <Head title="Room bookings" />
      <h1>Room bookings</h1>
      <section className="card">
        <Form route="bookings.store" className="stack">
          {(form) => (
            <>
              <div className="field">
                <label htmlFor="room_id">Room</label>
                <select id="room_id" {...form.field('room_id')}>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                    </option>
                  ))}
                </select>
                {form.error('room_id') && <small role="alert">{form.error('room_id')}</small>}
              </div>
              <div className="field">
                <label htmlFor="starts_at">From</label>
                <input id="starts_at" placeholder="2026-11-02T09:00:00Z" {...form.field('starts_at')} />
                {form.error('starts_at') && <small role="alert">{form.error('starts_at')}</small>}
              </div>
              <div className="field">
                <label htmlFor="ends_at">Until</label>
                <input id="ends_at" placeholder="2026-11-02T10:00:00Z" {...form.field('ends_at')} />
                {form.error('ends_at') && <small role="alert">{form.error('ends_at')}</small>}
              </div>
              <button type="submit" className="button" disabled={form.processing}>
                Book the room
              </button>
            </>
          )}
        </Form>
      </section>
      {bookings.length === 0 && <p className="muted">Nothing is booked.</p>}
      <ul className="stack">
        {bookings.map((booking) => (
          <li key={booking.id} className="card">
            {roomName(booking.room_id)}: {booking.starts_at} until {booking.ends_at}
          </li>
        ))}
      </ul>
    </main>
  );
}

ListBookings.layout = AppLayout;
```

Once the code above is in place, create the tables, write their columns into the app's types, and write the types of the new
routes, so the pages and `Link` know them:

```sh
pnpm marmeon migrate
pnpm marmeon db:types
pnpm marmeon route:types
```

On Postgres, `migrate` creates the extension and both constraints; on SQLite it skips those statements.

## The test

Each test names one of the dangers above. A guest is sent to the sign-in page. A free room is booked for the signed-in user. A
booking that starts before, ends inside, sits inside or covers an existing one is refused at `starts_at`, and the table still
holds one row. A booking that ends where the next starts is accepted, and so is the same hour in another room. An end before
the start and an unknown room are refused at their fields.

Two tests book at the same time. The first sends two requests from two users with `Promise.all` and expects exactly one to be
refused. The second calls `book()` twice together and expects one `ok` and one `err`. Both run on SQLite and on Postgres.

A test app with `database: 'refresh'` runs every query on one pinned connection, so requests that a test sends at the same
time take turns on it, as [database testing](database-testing.md#how-the-database-is-reset) says. That makes these two tests
check the rule, but not the race (a test that has to compete for real runs with `database: 'isolated'`, see [testing a lock](database-testing.md#testing-a-lock)). For the race, the Postgres test gives the repository a check that sees nothing, which is what
the second transaction sees when the first has not committed: the insert is then refused by the constraint alone, and `book()`
answers `overlap`. It runs only when the tests run on Postgres. The deadlock tests throw the deadlock error once, and expect the second
try to find the room taken, and throw it on every try, and expect `book()` to give up after the second. A period that ends
before it starts is refused by the controller, and, on Postgres, by the `bookings_period` constraint for a script.

```ts title="modules/bookings/bookings.test.ts"
import { UserFactory } from '#modules/auth';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { BookingRepository } from './BookingRepository.ts';
import type { ListBookingsController } from './controllers/ListBookingsController.ts';
import { RoomRepository } from './RoomRepository.ts';

// A room is never booked twice for the same minute: not by a second request after the first, and not by two at once.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const at = (time: string) => `2030-03-04T${time}:00Z`;
const booking = (room: number, from: string, until: string) => ({ form: { room_id: String(room), starts_at: at(from), ends_at: at(until) } });
const count = async () => (await app.make(BookingRepository).query().select('id').execute()).length;

describe('the bookings', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page', async () => {
    await app.get('/bookings').assertRedirect('/login');
    await app.post('/bookings', booking(1, '09:00', '10:00')).assertRedirect('/login');
  });

  it('books a free room for the signed-in user and shows the booking', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    await app.actingAs(ada).post('/bookings', booking(room.id, '09:00', '10:00')).assertRedirect('/bookings');

    expect(await app.make(BookingRepository).findBy('room_id', room.id)).toMatchObject({ user_id: ada.id, starts_at: '2030-03-04T09:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' });
    await app.actingAs(ada).navigating().get('/bookings').assertPage<ListBookingsController>('bookings/ListBookings', (props) => {
      expect(props.bookings.map((entry) => entry.room_id)).toEqual([room.id]);
    });
  });

  it('answers a booking that overlaps another one with an error at the form, whichever way they overlap', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    await app.actingAs(ada).post('/bookings', booking(room.id, '09:00', '11:00')).assertRedirect('/bookings');

    for (const [from, until] of [['09:00', '11:00'], ['08:00', '09:30'], ['10:30', '12:00'], ['09:30', '10:30'], ['08:00', '12:00']] as const) {
      await app.actingAs(ada).post('/bookings', booking(room.id, from, until)).assertRedirect().assertInvalid(['starts_at']);
    }
    expect(await count()).toBe(1);
  });

  it('lets one booking end at the minute the next one starts, and lets another room be booked at the same time', async () => {
    const ada = await app.factory(UserFactory).create();
    const rooms = app.make(RoomRepository);
    const blue = await rooms.insert({ name: 'Blue' });
    const red = await rooms.insert({ name: 'Red' });
    await app.actingAs(ada).post('/bookings', booking(blue.id, '09:00', '10:00')).assertRedirect('/bookings');
    await app.actingAs(ada).post('/bookings', booking(blue.id, '10:00', '11:00')).assertRedirect('/bookings');
    await app.actingAs(ada).post('/bookings', booking(blue.id, '08:00', '09:00')).assertRedirect('/bookings');
    await app.actingAs(ada).post('/bookings', booking(red.id, '09:00', '10:00')).assertRedirect('/bookings');
    expect(await count()).toBe(4);
  });

  it('refuses a booking that ends before it starts, and a room that does not exist', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    await app.actingAs(ada).post('/bookings', booking(room.id, '10:00', '09:00')).assertRedirect().assertInvalid(['ends_at']);
    await app.actingAs(ada).post('/bookings', booking(room.id, '10:00', '10:00')).assertRedirect().assertInvalid(['ends_at']);
    await app.actingAs(ada).post('/bookings', booking(room.id + 1, '09:00', '10:00')).assertRedirect().assertInvalid(['room_id']);
    expect(await count()).toBe(0);
  });

  it('lets exactly one of two bookings of the same room at the same time succeed', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });

    const answers = await Promise.all([
      app.actingAs(ada).post('/bookings', booking(room.id, '09:00', '10:00')),
      app.actingAs(bob).post('/bookings', booking(room.id, '09:30', '10:30')),
    ]);
    const refused = answers.filter((answer) => {
      try {
        answer.assertInvalid(['starts_at']);
        return true;
      } catch {
        return false;
      }
    });
    expect(refused).toHaveLength(1);
    expect(await count()).toBe(1);
  });

  it('says overlap from the repository when two callers both want the room', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    const bookings = app.make(BookingRepository);
    const first = { room_id: room.id, user_id: ada.id, starts_at: '2030-03-04T09:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' };

    expect((await Promise.all([bookings.book(first), bookings.book({ ...first, starts_at: '2030-03-04T09:30:00.000Z' })])).map((result) => result.ok).sort()).toEqual([false, true]);
    expect(await count()).toBe(1);
  });

  it('tries again when Postgres ends the booking as the victim of a deadlock, and then finds the room taken', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    const values = { room_id: room.id, user_id: ada.id, starts_at: '2030-03-04T09:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' };
    expect((await app.make(BookingRepository).book(values)).ok).toBe(true);

    // The first attempt dies with the error Postgres raises for the loser of a deadlock; the second one runs for real.
    let attempts = 0;
    class Victim extends BookingRepository {
      override transaction<R>(callback: (repository: this) => Promise<R>): Promise<R> {
        attempts += 1;
        if (attempts === 1) return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
        return super.transaction(callback);
      }
    }
    const victim = new Victim(app.make(Connections));
    expect(await victim.book({ ...values, starts_at: '2030-03-04T09:30:00.000Z' })).toMatchObject({ ok: false, error: { kind: 'overlap' } });
    expect(attempts).toBe(2);
    expect(await count()).toBe(1);
  });

  it('tries only once more: a second deadlock is thrown, and any other error is not tried again', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    const values = { room_id: room.id, user_id: ada.id, starts_at: '2030-03-04T09:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' };

    const failing = (code: string) => {
      const calls = { attempts: 0 };
      class Failing extends BookingRepository {
        override transaction<R>(): Promise<R> {
          calls.attempts += 1;
          return Promise.reject(Object.assign(new Error('failed'), { code }));
        }
      }
      return { calls, repository: new Failing(app.make(Connections)) };
    };

    const deadlocks = failing('40P01');
    await expect(deadlocks.repository.book(values)).rejects.toMatchObject({ code: '40P01' });
    expect(deadlocks.calls.attempts).toBe(2);
    // A serialization failure is not a lost race for this room; it is the caller's to handle.
    const serialization = failing('40001');
    await expect(serialization.repository.book(values)).rejects.toMatchObject({ code: '40001' });
    expect(serialization.calls.attempts).toBe(1);
  });

  it.runIf(process.env['DB_DRIVER'] === 'pgsql')('on Postgres, a row whose period is empty or reversed is refused, whoever inserts it', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    const values = { room_id: room.id, user_id: ada.id, starts_at: '2030-03-04T10:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' };

    // Straight through the repository's insert, as a script would: no check in the way. The failed statement ends the test's transaction.
    await expect(app.make(BookingRepository).insert(values)).rejects.toMatchObject({ code: '23514', constraint: 'bookings_period' });
  });

  it.runIf(process.env['DB_DRIVER'] === 'pgsql')('on Postgres, the constraint refuses the booking that passed the check', async () => {
    const ada = await app.factory(UserFactory).create();
    const room = await app.make(RoomRepository).insert({ name: 'Blue' });
    // A repository whose check sees nothing: what a second transaction sees when the first has not committed yet.
    class Blind extends BookingRepository {
      override async overlaps() {
        return false;
      }
    }
    const blind = new Blind(app.make(Connections));
    const values = { room_id: room.id, user_id: ada.id, starts_at: '2030-03-04T09:00:00.000Z', ends_at: '2030-03-04T10:00:00.000Z' };

    expect((await blind.book(values)).ok).toBe(true);
    expect(await blind.book({ ...values, starts_at: '2030-03-04T09:30:00.000Z' })).toMatchObject({ ok: false, error: { kind: 'overlap' } });
    // The refused insert was a savepoint: the transaction around it, and the first booking, are still there.
    expect(await count()).toBe(1);
  });
});
```

Run the module's tests on SQLite, and then on Postgres with the server of your choice:

```sh
pnpm test modules/bookings
DB_DRIVER=pgsql DB_URL=postgres://bookings:secret@localhost:5432/bookings pnpm test modules/bookings
```

The second command needs the `pg` package, and drops and creates the test databases on that server, as the
[database testing](database-testing.md#running-the-tests-on-postgres) page warns.

## Check

```sh
pnpm marmeon check
pnpm marmeon route:list
```

`marmeon check` passes with no finding in `raw-sql`: the only raw SQL of the recipe is in the migration, where the blueprint
cannot say it, and the queries use the query builder. `route:list` shows both routes with the access `everyone` and
`authenticate` among their middleware.

On Postgres, `\d bookings` in `psql` lists `bookings_no_overlap` under the exclusion constraints. A booking from a script that
bypasses `BookingRepository` meets the same refusal.

## Other ways on Postgres

The constraint is the right tool when the rule is "no two rows collide". Others suit other rules:

- **Lock the room.** Run the check and the insert in a transaction that first runs `select … for update` on the room's row.
  The second booking waits for the first to commit, then runs its check and sees it. It needs a row to lock, and every writer has to take the lock; a writer that does not is not
  stopped. It fits a rule that no constraint can say, such as "at most three open bookings per user".
- **Serializable isolation.** `connections.transaction(callback, { isolationLevel: 'serializable' })` makes Postgres abort one of
  two transactions that could not have run one after the other, with SQLSTATE `40001`. The aborted transaction is not wrong: it
  has to run again, from the check, and nothing in Marmeon does that for you. The loop is yours: catch the error at the
  outermost call, and run it again a few times.
- **An advisory lock.** `pg_advisory_xact_lock(key)` in the transaction serializes writers that share a key, with no row to
  lock. Like the row lock, it holds only against code that takes it.

SQLite needs none of this. It runs one writer at a time, so a transaction that checks and inserts cannot be interleaved with
another writer's, and the isolation level is ignored there. That holds inside one process, where Marmeon lets one transaction at
a time use the connection. Several processes on one file cannot book a room twice either, but the one that loses the race to the
file's lock fails with "database is locked" instead of answering `overlap`.

## Where to go next

- [Transactions](transactions.md) for savepoints, isolation levels and what a rollback takes back.
- [Queries](queries.md#writing) for `tryInsert()` and the `duplicate` error of a unique index.
- [Migrations](migrations.md#raw-sql) for raw SQL in a migration.
- [Validation](validation.md#the-unique-index-is-the-truth) for the same idea with a unique index.
- [Database testing](database-testing.md#running-the-tests-on-postgres) for running the suite on Postgres.
