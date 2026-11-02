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
  guests.middleware(throttle('guestbook')).post('/', StoreGuestbookEntryController).maxBodyBytes(32 * 1024).name('store');
  // ApprovedEntries finds approved entries only, so every visitor may read what it finds.
  guests.bind('entry', ApprovedEntries, { public: true }).get('/:entry', ShowGuestbookEntryController).name('show');
});
