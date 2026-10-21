import { defineModule } from '@marmeon/core';
import { GuestbookServiceProvider } from './GuestbookServiceProvider.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'guestbook',
  migrations: new URL('./migrations/', import.meta.url),
  providers: [GuestbookServiceProvider],
  routes,
});
