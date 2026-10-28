import { defineModule, listen } from '@marmeon/core';
import { AccountDeleted } from '#modules/auth';
import { ClearInbox } from './listeners/ClearInbox.ts';
import { NotificationsLiveAuthorizer } from './NotificationsLiveAuthorizer.ts';
import { NotificationsServiceProvider } from './NotificationsServiceProvider.ts';
import routes from './routes.ts';

/**
 * The signed-in user's notifications (`/notifications`) — the bell's list. What they say comes from the modules that
 * send them (`auth`: a new sign-in); this module only shows them, always the user's own (the Inbox of
 * @marmeon/notifications is bound to its recipient).
 */
export default defineModule({
  name: 'notifications',
  providers: [NotificationsServiceProvider],
  migrations: new URL('./migrations/', import.meta.url),
  routes,
  // The live stream asks it at every connection, so a channel whose right is gone is left out of the next one.
  liveAuthorizers: [NotificationsLiveAuthorizer],
  // A deleted account's notifications go with it.
  listeners: [listen(AccountDeleted, ClearInbox)],
});
