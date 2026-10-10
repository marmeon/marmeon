import { defineModule } from '@marmeon/core';
import { DashboardConfig } from './config.ts';
import routes from './routes.ts';

// Public API of the module — the members table asks who the administrators are.
export { DashboardConfig } from './config.ts';

/** The dashboard (`/dashboard`): a page of islands — each panel a route of its own. */
export default defineModule({
  name: 'dashboard',
  config: [DashboardConfig],
  routes,
});
