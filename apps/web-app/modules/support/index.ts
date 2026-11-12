import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

/** The contact page of the help (`/help/contact`): a route of its own under the help's fallback, which loads before this module. Open to everyone. */
export default defineModule({
  name: 'support',
  routes,
});
