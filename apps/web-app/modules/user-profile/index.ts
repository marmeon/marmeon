import { Login } from '@bespokecore/auth';
import { defineModule, listen } from '@bespokecore/core';
import { RecordLastLogin } from './listeners/RecordLastLogin.ts';
import { DemoLinksSeeder } from './seeders/DemoLinksSeeder.ts';
import apiRoutes from './api-routes.ts';
import routes from './routes.ts';
import { UserProfileServiceProvider } from './UserProfileServiceProvider.ts';
import { ProfileConfig } from './config.ts';

export default defineModule({
  name: 'user-profile',
  providers: [UserProfileServiceProvider],
  config: [ProfileConfig],
  listeners: [listen(Login, RecordLastLogin)],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [DemoLinksSeeder],
  routes,
  apiRoutes,
});
