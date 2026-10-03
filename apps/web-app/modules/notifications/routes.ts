import { authenticate } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';
import { MarkAllNotificationsReadController } from './controllers/MarkAllNotificationsReadController.ts';
import { MarkNotificationReadController } from './controllers/MarkNotificationReadController.ts';
import { ShowNotificationsController } from './controllers/ShowNotificationsController.ts';

export default defineRoutes((Route) => {
  const inbox = Route.prefix('/notifications').middleware(authenticate()).name('notifications.');
  inbox.get('/', ShowNotificationsController).name('index');
  // Actions (E59): the list changes at once (optimistic), the answer only confirms it.
  inbox.post('/read-all', MarkAllNotificationsReadController).name('read-all');
  inbox.post('/:notification/read', MarkNotificationReadController).name('read');
});
