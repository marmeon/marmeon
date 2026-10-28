import { defineModule } from '@marmeon/core';
import { LabConfig } from './config.ts';
import { LabServiceProvider } from './LabServiceProvider.ts';
import routes from './routes.ts';

/** How server rendering behaves when it is slow or fails — pages under `/lab`, off in production. */
export default defineModule({
  name: 'lab',
  config: [LabConfig],
  migrations: new URL('./migrations/', import.meta.url),
  providers: [LabServiceProvider],
  routes,
});
