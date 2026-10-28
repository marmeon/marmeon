import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone, signed } from '@marmeon/http';
import { ConfirmUnsubscribeController } from './controllers/ConfirmUnsubscribeController.ts';
import { DeleteNotificationController } from './controllers/DeleteNotificationController.ts';
import { MarkAllNotificationsReadController } from './controllers/MarkAllNotificationsReadController.ts';
import { MarkNotificationReadController } from './controllers/MarkNotificationReadController.ts';
import { ShowNotificationsController } from './controllers/ShowNotificationsController.ts';
import { UnsubscribeController } from './controllers/UnsubscribeController.ts';

export default defineRoutes((Route) => {
  // Decided for this inbox only: every action addresses `ctx.user`'s own notifications. The inbox looks a notification up within its
  // recipient, so another user's id is a 404. A route you add needs its own decision.
  const inbox = Route.prefix('/notifications').middleware(authenticate()).middleware(verified()).name('notifications.');
  const open = inbox.authorize(everyone);
  open.get('/', ShowNotificationsController).name('index');
  // Actions: the list changes at once (optimistic), the answer only confirms it.
  open.post('/read-all', MarkAllNotificationsReadController).name('read-all');
  open.post('/:notification/read', MarkNotificationReadController).name('read');
  open.delete('/:notification', DeleteNotificationController).name('destroy');

  // Outside the signed-in group: a mail client posts to the signed link with no session, and a reader who clicks it gets a page. The link is
  // the ticket, and it is why the post needs neither a CSRF token nor a `csrfExcept`: a post without a valid signature meets the CSRF
  // check first, and then `signed()`. The page (GET) leaves nothing, so only the post needs `withoutCsrf`.
  const mail = Route.prefix('/notifications/unsubscribe').middleware(throttle('notifications.unsubscribe')).authorize(everyone);
  mail.middleware(signed({ forever: true })).get('/:user', ConfirmUnsubscribeController).name('notifications.unsubscribe.confirm');
  mail.middleware(signed({ forever: true, withoutCsrf: true })).post('/:user', UnsubscribeController).name('notifications.unsubscribe');
});
