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
