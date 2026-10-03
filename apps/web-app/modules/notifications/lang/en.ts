/** The texts of the notifications list — the source language. */
const en = {
  title: 'Notifications',
  none: 'No notifications.',
  mark_read: 'Mark as read',
  mark_all_read: 'Mark all as read',
  unread: 'Unread',
  unknown: 'A notification',
  new_sign_in: {
    title: 'New sign-in to your account',
    body: 'From {ip} · {browser}',
  },
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    notifications: typeof en;
  }
}
