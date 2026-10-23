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
