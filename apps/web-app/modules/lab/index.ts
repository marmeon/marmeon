import { defineModule } from '@marmeon/core';
import { LabConfig } from './config.ts';
import routes from './routes.ts';

/** How server rendering behaves when it is slow or fails — pages under `/lab`, off in production. */
export default defineModule({
  name: 'lab',
  config: [LabConfig],
  routes,
});
