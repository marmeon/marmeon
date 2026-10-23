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
