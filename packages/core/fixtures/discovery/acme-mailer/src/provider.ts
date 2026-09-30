import { Mailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

interface Bindings {
  bind(key: unknown, concrete: unknown): unknown;
}

export class MailServiceProvider {
  register(container: Bindings) {
    container.bind(Mailer, SmtpMailer);
  }
}
