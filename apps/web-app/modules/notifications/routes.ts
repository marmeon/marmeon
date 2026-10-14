import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { DeleteNotificationController } from './controllers/DeleteNotificationController.ts';
import { MarkAllNotificationsReadController } from './controllers/MarkAllNotificationsReadController.ts';
import { MarkNotificationReadController } from './controllers/MarkNotificationReadController.ts';
import { ShowNotificationsController } from './controllers/ShowNotificationsController.ts';

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
});
