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
