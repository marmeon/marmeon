import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

/** The help pages (`/en/help`, `/de/help`): nested pages under one route that takes the rest of the path, in each language. Open to everyone. */
export default defineModule({
  name: 'help',
  routes,
});
