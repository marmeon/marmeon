import { setTimeout } from 'node:timers/promises';
import { defineModule } from '@marmeon/core';
import { Connections, type Generated } from '@marmeon/database';
import { Controller } from '@marmeon/http';
import { openRoutes } from '../test-helpers/open-routes.ts';

export interface WorkshopTables {
  workshops: { id: Generated<number>; capacity: number };
  bookings: { id: Generated<number>; workshop_id: number; guest: string };
}

/**
 * Books a seat of workshop 1: reads the free seats, thinks for a moment (a price, a mail, a second query), then inserts. Without
 * the row lock, requests that run together all read the same free seats and overbook.
 */
async function book(connections: Connections, locked: boolean): Promise<Response> {
  const db = connections.get<WorkshopTables>();
  const booked = await connections.transaction(async () => {
    const workshop = db.selectFrom('workshops').select('capacity').where('id', '=', 1);
    const { capacity } = await (locked ? workshop.forUpdate() : workshop).executeTakeFirstOrThrow();
    const taken = await db.selectFrom('bookings').select(({ fn }) => fn.countAll().as('taken')).where('workshop_id', '=', 1).executeTakeFirstOrThrow();
    await setTimeout(30);
    if (Number(taken.taken) >= capacity) return false;
    await db.insertInto('bookings').values({ workshop_id: 1, guest: 'Ada' }).execute();
    return true;
  });
  return Response.json({ booked }, { status: booked ? 201 : 409 });
}

export class BookWithLockController extends Controller {
  readonly #connections: Connections;
  constructor(connections: Connections) {
    super();
    this.#connections = connections;
  }
  handle() {
    return book(this.#connections, true);
  }
}

export class BookWithoutLockController extends Controller {
  readonly #connections: Connections;
  constructor(connections: Connections) {
    super();
    this.#connections = connections;
  }
  handle() {
    return book(this.#connections, false);
  }
}

/** Workshops with a limited number of seats, booked with and without `for update`. */
export const workshops = defineModule({
  name: 'workshops',
  migrations: new URL('./workshop-migrations/', import.meta.url),
  routes: openRoutes((Route) => {
    Route.post('/book/locked', BookWithLockController);
    Route.post('/book/unlocked', BookWithoutLockController);
  }),
});
