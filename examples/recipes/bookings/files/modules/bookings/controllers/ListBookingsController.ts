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
