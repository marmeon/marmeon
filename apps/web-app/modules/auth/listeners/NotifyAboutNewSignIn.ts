import type { Login } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { Notifications } from '@marmeon/notifications';
import { NewSignInNotification } from '../notifications/NewSignInNotification.ts';

/**
 * A sign-in with a password or a passkey tells the user — a queued listener: the sign-in only queues it, a worker sends the
 * notification. Not for the sign-in right after registering (`via: 'login'`, the app signs the new account in) nor for
 * a remember-me cookie (the same browser, continued). A passkey sign-in is a new sign-in like any other: with no password
 * typed, the notice is the owner's only hint that somebody got in.
 */
export class NotifyAboutNewSignIn {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-new-sign-in';
  static readonly queue = {};

  readonly #notifications: Notifications;

  constructor(notifications: Notifications) {
    this.#notifications = notifications;
  }

  async handle(payload: EventPayload<typeof Login>): Promise<void> {
    if (payload.via !== 'attempt' && payload.via !== 'passkey') return;
    // Already in a worker: delivered here (a row, and a queued mail) — no second job.
    await this.#notifications.sendNow({ type: 'user', id: payload.userId as number }, NewSignInNotification, { at: payload.at, ip: payload.ip, agent: payload.userAgent });
  }
}
