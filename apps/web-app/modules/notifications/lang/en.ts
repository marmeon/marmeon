/** The texts of the notifications list — the source language. */
const en = {
  title: 'Notifications',
  none: 'No notifications.',
  mark_read: 'Mark as read',
  mark_all_read: 'Mark all as read',
  more: 'Load more',
  delete: 'Delete',
  confirm_delete: 'Delete this notification?',
  unread: 'Unread',
  unknown: 'A notification',
  new_sign_in: {
    title: 'New sign-in to your account',
    body: 'From {ip} · {browser}',
  },
  mail: {
    digest: {
      subject: 'Your notifications',
      intro: 'You have new notifications.',
      unsubscribe: 'Stop these mails',
      page_title: 'Stop these mails?',
      page_body: 'The digest will no longer be sent to {email}.',
      page_button: 'Stop the mails',
    },
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    notifications: typeof en;
  }
}
