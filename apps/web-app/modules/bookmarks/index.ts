import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'bookmarks',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
