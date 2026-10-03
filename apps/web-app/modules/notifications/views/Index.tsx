import type { PageProps } from '@bespokecore/http';
import { Head, useAction, useRouter, useTranslation } from '@bespokecore/react';
import { ActionFailure } from '../../../layouts/ActionFailure.tsx';
import type { ShowNotificationsController } from '../controllers/ShowNotificationsController.ts';

type Props = PageProps<ShowNotificationsController>;

export default function Index({ notifications }: Props) {
  const t = useTranslation('notifications');
  // In UTC: the server and the browser render the same text.
  const at = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const router = useRouter<ShowNotificationsController>();
  // Actions (E59): the notification shows read at once and the bell counts one less — rolled back if the server says no
  // (someone else's id: 404). Then the list and the bell come again from the server (a notification may have come meanwhile) —
  // a reload replaces all of the action's patches when it lands, so it names every prop they touch.
  const markRead = useAction('notifications.read');
  const markAllRead = useAction('notifications.read-all');
  const unread = notifications.filter((notification) => !notification.read).length;

  const read = (id: string) =>
    void markRead.submit({
      params: { notification: id },
      optimistic: router.optimistic((props) => ({
        notifications: props.notifications.map((notification) => (notification.id === id ? { ...notification, read: true } : notification)),
        bell: props.bell && { unread: Math.max(0, props.bell.unread - 1) },
      })),
      reload: router.reloading({ only: ['notifications', 'bell'] }),
    });
  const readAll = () =>
    void markAllRead.submit({
      optimistic: router.optimistic((props) => ({
        notifications: props.notifications.map((notification) => ({ ...notification, read: true })),
        bell: props.bell && { unread: 0 },
      })),
      reload: router.reloading({ only: ['notifications', 'bell'] }),
    });

  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <ActionFailure exception={markRead.exception ?? markAllRead.exception} />
      {unread > 0 && (
        <p>
          <button type="button" onClick={readAll} data-mark-all-read="">
            {t('mark_all_read')}
          </button>
        </p>
      )}
      {notifications.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <ul data-notifications="">
          {notifications.map((notification) => (
            <li key={notification.id} data-notification={notification.id} data-read={notification.read ? '' : undefined} style={{ opacity: notification.read ? 0.6 : 1 }}>
              <strong>{notification.title}</strong>
              {!notification.read && <span aria-label={t('unread')}> ●</span>} — <time dateTime={notification.at}>{at(notification.at)} UTC</time>
              {notification.body && <div>{notification.body}</div>}
              {!notification.read && (
                <button type="button" onClick={() => read(notification.id)}>
                  {t('mark_read')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
