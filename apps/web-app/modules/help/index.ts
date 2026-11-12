import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

/** The help pages (`/help`): nested pages under one route that takes the rest of the path. Open to everyone. */
export default defineModule({
  name: 'help',
  routes,
});
