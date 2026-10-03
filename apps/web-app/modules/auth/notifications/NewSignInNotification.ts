import type { Translator } from '@bespokecore/i18n';
import type { DatabaseInput, Notification, NotificationData } from '@bespokecore/notifications';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { NewSignInMail } from '../mail/NewSignInMail.ts';
import type { User } from '../users.ts';
import { describeBrowser } from './browser.ts';

/**
 * "Someone signed in to your account" — after every sign-in with a password (not the one right after registering, not
 * a remember-me cookie): in the bell for everyone, by mail only to a confirmed address (an unconfirmed one may not even
 * be the user's). Its job and its mail run on the `mail` queue.
 */
export class NewSignInNotification implements Notification<'user'> {
  static readonly notification = 'auth.new-sign-in';
  static readonly schema = v.object({ at: v.pipe(v.string(), v.isoTimestamp()), ip: v.nullable(v.string()), agent: v.nullable(v.string()) });
  /** What the bell keeps: when, from where, which browser — never the raw user agent. */
  static readonly database = v.object({ at: v.string(), ip: v.nullable(v.string()), browser: v.nullable(v.string()) });
  static readonly queue = { queue: 'mail' };

  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    this.#app = app;
  }

  via(user: User) {
    return user.email_verified_at !== null ? (['database', 'mail'] as const) : (['database'] as const);
  }

  toDatabase(data: NotificationData<typeof NewSignInNotification>): DatabaseInput<typeof NewSignInNotification> {
    return { at: data.at, ip: data.ip, browser: describeBrowser(data.agent) };
  }

  /** `t` speaks the user's language (their `locale`), whatever the language of the sign-in. */
  toMail(user: User, data: NotificationData<typeof NewSignInNotification>, t: Translator) {
    return new NewSignInMail(user, { at: data.at, ip: data.ip, browser: describeBrowser(data.agent) }, new URL('/settings/security', this.#app.url).href, t);
  }
}
