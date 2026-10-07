import { defineModule, listen } from '@marmeon/core';
import { AccountDeleted } from '#modules/auth';
import { ClearInbox } from './listeners/ClearInbox.ts';
import routes from './routes.ts';

/**
 * The signed-in user's notifications (`/notifications`) — the bell's list. What they say comes from the modules that
 * send them (`auth`: a new sign-in); this module only shows them, always the user's own (the Inbox of
 * @marmeon/notifications is bound to its recipient).
 */
export default defineModule({
  name: 'notifications',
  routes,
  // A deleted account's notifications go with it (E203).
  listeners: [listen(AccountDeleted, ClearInbox)],
});
