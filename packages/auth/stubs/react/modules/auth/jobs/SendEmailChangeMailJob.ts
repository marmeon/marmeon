import { Clock } from '@marmeon/core';
import { UrlSigner } from '@marmeon/http';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { emailChangeTokenHash } from '../email-change.ts';
import { ConfirmNewEmailMail } from '../mail/ConfirmNewEmailMail.ts';
import { EmailInUseMail } from '../mail/EmailInUseMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * Private registration (E146): a user asked to change their address. The request only wrote the pending change and queued this
 * job — the same for every address —, so here, in a worker, it is decided what goes out: to a free address the link that confirms
 * it (signed, for this account and this request, expiring with it); to the owner of a taken one a note that someone wanted to use
 * it — nothing changes for anybody then. The address and the token are personal data: the payload is encrypted (E105).
 */
export class SendEmailChangeMailJob {
  static readonly job = 'auth.send-email-change-mail';
  /** The account, the new address, the link's token (the row keeps its hash) and the language of the request. */
  static readonly schema = v.object({ user: v.number(), email: v.string(), token: v.string(), locale: v.string() });
  static readonly encrypted = true;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #signer: UrlSigner;
  readonly #translators: Translators;
  readonly #clock: Clock;
  readonly #app: AppConfig;

  constructor(users: UserRepository, mailer: Mailer, signer: UrlSigner, translators: Translators, clock: Clock, app: AppConfig) {
    this.#users = users;
    this.#mailer = mailer;
    this.#signer = signer;
    this.#translators = translators;
    this.#clock = clock;
    this.#app = app;
  }

  async handle(payload: JobPayload<typeof SendEmailChangeMailJob>): Promise<void> {
    // Only the request that is still pending: a newer one replaced it, it was used, cancelled — or it expired while queued.
    const expiresAt = await this.#users.pendingEmailChange(payload.user, payload.email, emailChangeTokenHash(payload.token));
    const left = Math.floor(((expiresAt?.getTime() ?? 0) - this.#clock.now()) / 1000);
    if (left <= 0) return;
    const user = await this.#users.find(payload.user);
    if (!user) return;
    const owner = await this.#users.findByEmail(payload.email);
    if (owner) {
      await this.#mailer.queue(new EmailInUseMail(owner, this.#translators.for(owner.locale ?? payload.locale)), { queue: 'mail' });
      return;
    }
    // The link expires with the request; it works for the signed-in account it names (ConfirmEmailChangeController).
    const link = this.#signer.temporarySignedRoute('auth.email.confirm', { id: user.id, token: payload.token }, left, { base: this.#app.url });
    await this.#mailer.queue(new ConfirmNewEmailMail(user, payload.email, link, this.#translators.for(user.locale ?? payload.locale)), { queue: 'mail' });
  }
}
