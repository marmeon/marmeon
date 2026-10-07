import type { PageProps } from '@marmeon/http';
import { Head, Link, useAction, useRouter, useTranslation } from '@marmeon/react';
import { ActionFailure } from '../../../layouts/ActionFailure.tsx';
import type { ShowNotificationsController } from '../controllers/ShowNotificationsController.ts';

type Props = PageProps<ShowNotificationsController>;

export default function Index({ notifications }: Props) {
  const t = useTranslation('notifications');
  // In UTC: the server and the browser render the same text.
  const at = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const router = useRouter<ShowNotificationsController>();
  // Actions (E59): the notification shows read (or gone) at once and the bell counts one less — rolled back if the server says no
  // (someone else's id: 404). Then the list and the bell come again from the server (a notification may have come meanwhile) —
  // a reload replaces all of the action's patches when it lands, so it names every prop they touch. The list is merge()d for
  // "load more", but a reload after an action replaces it (E183): a deleted notification never comes back from what was loaded.
  const markRead = useAction('notifications.read');
  const markAllRead = useAction('notifications.read-all');
  const destroy = useAction('notifications.destroy');
  const list = notifications.data;
  const unread = list.filter((notification) => !notification.read).length;
  const reload = router.reloading({ only: ['notifications', 'bell'] });

  const read = (id: string) =>
    void markRead.submit({
      params: { notification: id },
      optimistic: router.optimistic((props) => ({
        notifications: { ...props.notifications, data: props.notifications.data.map((notification) => (notification.id === id ? { ...notification, read: true } : notification)) },
        bell: props.bell && { unread: Math.max(0, props.bell.unread - 1) },
      })),
      reload,
    });
  const readAll = () =>
    void markAllRead.submit({
      optimistic: router.optimistic((props) => ({
        notifications: { ...props.notifications, data: props.notifications.data.map((notification) => ({ ...notification, read: true })) },
        bell: props.bell && { unread: 0 },
      })),
      reload,
    });
  const remove = (id: string, wasUnread: boolean) =>
    void destroy.submit({
      params: { notification: id },
      confirm: t('confirm_delete'),
      optimistic: router.optimistic((props) => ({
        notifications: { ...props.notifications, data: props.notifications.data.filter((notification) => notification.id !== id) },
        bell: props.bell && { unread: Math.max(0, props.bell.unread - (wasUnread ? 1 : 0)) },
      })),
      reload,
    });

  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <ActionFailure exception={markRead.exception ?? markAllRead.exception ?? destroy.exception} />
      {unread > 0 && (
        <p>
          <button type="button" onClick={readAll} data-mark-all-read="">
            {t('mark_all_read')}
          </button>
        </p>
      )}
      {list.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <ul data-notifications="">
          {list.map((notification) => (
            <li key={notification.id} data-notification={notification.id} data-read={notification.read ? '' : undefined}>
              <strong>{notification.title}</strong>
              {!notification.read && <span aria-label={t('unread')}> ●</span>} — <time dateTime={notification.at}>{at(notification.at)} UTC</time>
              {notification.body && <div>{notification.body}</div>}
              {!notification.read && (
                <button type="button" onClick={() => read(notification.id)}>
                  {t('mark_read')}
                </button>
              )}{' '}
              <button type="button" onClick={() => remove(notification.id, !notification.read)} data-delete="">
                {t('delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notifications.meta.nextCursor && (
        // The next ten, appended (`notifications` is merge()d on the server, matched on the id) — the URL stays the list's, so a
        // reload starts over at the top. Without JavaScript, a plain link.
        <Link route="notifications.index" query={{ cursor: notifications.meta.nextCursor }} only={['notifications']} preserveUrl preserveScroll preserveState data-more="">
          {t('more')}
        </Link>
      )}
    </main>
  );
}
