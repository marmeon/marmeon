import { Connections } from '@marmeon/database';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { OfficeGuard } from './guard.ts';
import { OfficeSecurityMail, type OfficeSecurityNotice } from './OfficeSecurityMail.ts';

/**
 * Queues the mail about an editor's sign-ins and second factors, from the queued listeners the app lists. The address is read from `office_users` by
 * the id the guard's event carries, never from the app's `users`: the same id there is another person. An editor who is gone by now gets nothing.
 */
export class OfficeNotices {
  static readonly inject = [Connections, Mailer, Translators] as const;

  readonly #connections: Connections;
  readonly #mailer: Mailer;
  readonly #translators: Translators;

  constructor(connections: Connections, mailer: Mailer, translators: Translators) {
    this.#connections = connections;
    this.#mailer = mailer;
    this.#translators = translators;
  }

  /**
   * Mails the editor `payload.userId` names, for a payload of the guard `office` only: an id means another person in another guard's table, so a payload
   * that names another guard, or none, mails nobody.
   */
  /**
   * The mail for the second factor going away. The event does not say what is left: an editor who still has a passkey of the guard (`office_passkeys`,
   * never the app's table) lost the authenticator app only and is still protected, so the mail says that and not "off". An operator's or a reset's
   * removal takes the passkeys along and says so.
   */
  async sendTwoFactorDisabled(payload: { readonly guard?: string | undefined; readonly userId: number | string; readonly via: 'user' | 'operator' | 'reset' }): Promise<void> {
    if (payload.guard !== OfficeGuard.name) return;
    if (payload.via === 'reset') return this.send(payload, { kind: 'twoFactorDisabledByReset' });
    if (payload.via === 'operator') return this.send(payload, { kind: 'twoFactorDisabledByOperator' });
    const left = await this.#connections
      .get<{ office_passkeys: { id: number; user_id: number } }>()
      .selectFrom('office_passkeys')
      .select('id')
      .where('user_id', '=', Number(payload.userId))
      .limit(1)
      .executeTakeFirst();
    await this.send(payload, { kind: left ? 'authenticatorRemoved' : 'twoFactorDisabled' });
  }

  async send(payload: { readonly guard?: string | undefined; readonly userId: number | string }, notice: OfficeSecurityNotice): Promise<void> {
    if (payload.guard !== OfficeGuard.name) return;
    const editor = await this.#connections
      .get<{ office_users: { id: number; name: string; email: string } }>()
      .selectFrom('office_users')
      .select(['name', 'email'])
      .where('id', '=', Number(payload.userId))
      .executeTakeFirst();
    if (!editor) return;
    await this.#mailer.queue(new OfficeSecurityMail(editor, notice, this.#translators.for(null)), { queue: 'mail' });
  }
}
