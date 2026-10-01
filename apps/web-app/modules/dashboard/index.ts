import { defineModule } from '@bespokecore/core';
import { DashboardConfig } from './config.ts';
import routes from './routes.ts';

/** The dashboard (`/dashboard`): a page of islands — each panel a route of its own (E48). */
export default defineModule({
  name: 'dashboard',
  config: [DashboardConfig],
  routes,
});
