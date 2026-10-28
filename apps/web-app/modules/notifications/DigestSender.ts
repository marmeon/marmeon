import { UrlSigner } from '@marmeon/http';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { User } from '#modules/auth';
import { AppConfig } from '../../config/app.ts';
import { DigestMail } from './mail/DigestMail.ts';
import { OptOutRepository } from './OptOutRepository.ts';

/** Sends the digest to a user, unless the user left the list. */
export class DigestSender {
  readonly #optOuts: OptOutRepository;
  readonly #mailer: Mailer;
  readonly #signer: UrlSigner;
  readonly #app: AppConfig;
  readonly #translators: Translators;

  constructor(optOuts: OptOutRepository, mailer: Mailer, signer: UrlSigner, app: AppConfig, translators: Translators) {
    this.#optOuts = optOuts;
    this.#mailer = mailer;
    this.#signer = signer;
    this.#app = app;
    this.#translators = translators;
  }

  /** Whether a mail went out. */
  async send(user: User): Promise<boolean> {
    if (await this.#optOuts.has(user.id)) return false;
    const unsubscribe = DigestMail.unsubscribeUrl(this.#signer, this.#app, user.public_id);
    await this.#mailer.send(new DigestMail(user.email, unsubscribe, this.#translators.for(user.locale)));
    return true;
  }
}
