import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

/** The language switcher (`POST /locale`) — its texts live in the app-wide `lang/` (namespace `app`). */
export default defineModule({
  name: 'locale',
  routes,
});
