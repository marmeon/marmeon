import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

/** The public pages (`/about`): open to everyone, the same for guests and members — where features of the framework show. */
export default defineModule({
  name: 'about',
  routes,
});
