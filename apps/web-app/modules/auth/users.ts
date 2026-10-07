import type { Row } from '@marmeon/database';

/** A user as stored — typed by the migration (bootstrap/database.d.ts). Without the password hash: it is a secret column. */
export type User = Row<'users'>;

declare module '@marmeon/auth' {
  interface AuthTypes {
    user: User;
  }
}

declare module '@marmeon/notifications' {
  interface NotificationRecipients {
    /** Users get notifications as `{ type: 'user', id: user.id }` — found again by `UserRecipients`. */
    user: User;
  }
}
