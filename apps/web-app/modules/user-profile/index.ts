import { defineModule, listen } from '@bespokecore/core';
import { UserLoggedIn } from '#modules/auth';
import { RecordLastLogin } from './listeners/RecordLastLogin.ts';
import routes from './routes.ts';
import { UserProfileServiceProvider } from './UserProfileServiceProvider.ts';

export default defineModule({
  name: 'user-profile',
  providers: [UserProfileServiceProvider],
  listeners: [listen(UserLoggedIn, RecordLastLogin)],
  routes,
});
