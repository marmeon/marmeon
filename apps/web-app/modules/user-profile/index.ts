import { defineModule, listen } from '@bespokecore/core';
import { UserLoggedIn } from '#modules/auth';
import { RecordLastLogin } from './listeners/RecordLastLogin.ts';
import { DemoLinksSeeder } from './seeders/DemoLinksSeeder.ts';
import apiRoutes from './api-routes.ts';
import routes from './routes.ts';
import { UserProfileServiceProvider } from './UserProfileServiceProvider.ts';

export default defineModule({
  name: 'user-profile',
  providers: [UserProfileServiceProvider],
  listeners: [listen(UserLoggedIn, RecordLastLogin)],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [DemoLinksSeeder],
  routes,
  apiRoutes,
});
