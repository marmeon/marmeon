import { defineModule } from '@marmeon/core';
import { LabConfig } from './config.ts';
import apiRoutes from './api-routes.ts';
import { LabServiceProvider } from './LabServiceProvider.ts';
import { LocalOidcServiceProvider } from './LocalOidcServiceProvider.ts';
import routes from './routes.ts';

/**
 * How server rendering behaves when it is slow or fails: pages under `/lab`, off in production.
 * Also a local OpenID Connect provider under `/_dev/oidc` for trying social sign-in, in development and test only.
 */
export default defineModule({
  name: 'lab',
  config: [LabConfig],
  migrations: new URL('./migrations/', import.meta.url),
  providers: [LabServiceProvider, LocalOidcServiceProvider],
  routes,
  apiRoutes,
});
