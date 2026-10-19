import { createHash } from 'node:crypto';
import { EmailChangeStore } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Clock } from '@marmeon/core';
import { UrlSigner } from '@marmeon/http';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { ConfirmNewEmailMail } from '../mail/ConfirmNewEmailMail.ts';
import { EmailInUseMail } from '../mail/EmailInUseMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * Private registration: a user asked to change their address. The request only stored the pending change and queued this
 * job — the same for every address —, so here, in a worker, it is decided what goes out: to a free address the link that confirms
 * it (signed, for this account and this request, expiring with it); to the owner of a taken one a note that someone wanted to use
 * it — nothing changes for anybody then. At most two mails an hour go to an address for one account (asking for X, then Y, then X again must still deliver the last link), and three an hour to an address whoever asks: change
 * requests must not make the kit a mail cannon against a stranger — and one account's requests must not use up the others' share. The address and the token are personal data: the payload is encrypted.
 */
export class SendEmailChangeMailJob {
  static readonly job = 'auth.send-email-change-mail';
  /** The account, the new address, the link's token (the store keeps its hash) and the language of the request. */
  static readonly schema = r.object({ user: r.integer(), email: r.string(), token: r.string(), locale: r.string() });
  static readonly encrypted = true;

  readonly #users: UserRepository;
  readonly #changes: EmailChangeStore;
  readonly #mailer: Mailer;
  readonly #signer: UrlSigner;
  readonly #translators: Translators;
  readonly #clock: Clock;
  readonly #app: AppConfig;
  readonly #limiter: RateLimiter;

  constructor(users: UserRepository, changes: EmailChangeStore, mailer: Mailer, signer: UrlSigner, translators: Translators, clock: Clock, app: AppConfig, limiter: RateLimiter) {
    this.#users = users;
    this.#changes = changes;
    this.#mailer = mailer;
    this.#signer = signer;
    this.#translators = translators;
    this.#clock = clock;
    this.#app = app;
    this.#limiter = limiter;
  }

  async handle(payload: JobPayload<typeof SendEmailChangeMailJob>): Promise<void> {
    // Only the request that is still pending: a newer one replaced it, it was used, cancelled — or it expired while queued.
    // Asked of the store, not of `EmailChange`: a worker has no session, and `EmailChange` is the signed-in user's.
    const expiresAt = await this.#changes.pending(payload.user, payload.email, payload.token);
    const left = Math.floor(((expiresAt?.getTime() ?? 0) - this.#clock.now()) / 1000);
    if (left <= 0) return;
    const user = await this.#users.find(payload.user);
    if (!user) return;
    // Keyed on the address, hashed: no plain address in the cache. A refused attempt sends nothing and says nothing. The first limit is per
    // address and account, the second per address: a stranger who keeps asking for an address cannot shut its owner's own change out.
    const hashed = createHash('sha256').update(payload.email).digest('hex');
    const own = `email-change-mail:${hashed}:${user.id}`;
    const all = `email-change-mail:${hashed}`;
    if (!(await this.#limiter.attempt(own, 2, 3600))) return;
    if (!(await this.#limiter.attempt(all, 3, 3600))) {
      await this.#limiter.clear(own);
      return;
    }
    try {
      const owner = await this.#users.findByEmail(payload.email);
      if (owner) {
        await this.#mailer.queue(new EmailInUseMail(owner, this.#translators.for(owner.locale ?? payload.locale)), { queue: 'mail' });
        return;
      }
      // The link expires with the request; it works for the signed-in account it names (ConfirmEmailChangeController).
      const link = this.#signer.temporarySignedRoute('auth.email.confirm', { id: user.id, token: payload.token }, left, { base: this.#app.url });
      await this.#mailer.queue(new ConfirmNewEmailMail(user, payload.email, link, this.#translators.for(user.locale ?? payload.locale)), { queue: 'mail' });
    } catch (error) {
      await this.#limiter.clear(own); // nothing was sent: the retry of the job may still send it
      await this.#limiter.clear(all);
      throw error;
    }
  }
}
