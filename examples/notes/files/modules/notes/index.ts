import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
