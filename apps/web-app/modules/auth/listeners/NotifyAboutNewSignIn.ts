import type { Login } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { Notifications } from '@marmeon/notifications';
import { NewSignInNotification } from '../notifications/NewSignInNotification.ts';

/**
 * A sign-in with a password tells the user — a queued listener: the sign-in only queues it, a worker sends the
 * notification. Not for the sign-in right after registering (`via: 'login'`, the app signs the new account in) nor for
 * a remember-me cookie (the same browser, continued).
 */
export class NotifyAboutNewSignIn {
  static readonly queue = {};

  readonly #notifications: Notifications;

  constructor(notifications: Notifications) {
    this.#notifications = notifications;
  }

  async handle(payload: EventPayload<typeof Login>): Promise<void> {
    if (payload.via !== 'attempt') return;
    // Already in a worker: delivered here (a row, and a queued mail) — no second job.
    await this.#notifications.sendNow({ type: 'user', id: payload.userId as number }, NewSignInNotification, { at: payload.at, ip: payload.ip, agent: payload.userAgent });
  }
}
