import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

// The notes demo: people keep notes, pin the important ones, and see only their own.
export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
