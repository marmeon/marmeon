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
