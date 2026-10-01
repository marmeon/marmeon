import { Application, defineConfig, Logger, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';
import { Mailer, TransportMailer } from './mailer.ts';
import { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';

// Mail (E29): mails as classes, a transport behind a neutral message type, UI-agnostic content (MJML or HTML).
export { escapeHtml, fromHtml, Html, html, raw, textFromHtml } from './html.ts';
export { fromMjml, Mjml, mjml, MjmlError } from './mjml.ts';
export type { Address, Attachment, Envelope, Mailable, MailContent, MailMessage } from './message.ts';
export { compose, MailError, Mailer, TransportMailer } from './mailer.ts';
export { MailFake } from './fake.ts';
export { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';
export type { SmtpOptions } from './transports.ts';

export const MailConfig = defineConfig('mail', {
  env: v.object({
    /** `log` (default: written to the log, nothing is sent), `array` (kept in memory) or `smtp` (needs nodemailer). */
    MAIL_MAILER: v.optional(v.picklist(['log', 'array', 'smtp']), 'log'),
    MAIL_FROM_ADDRESS: v.optional(v.pipe(v.string(), v.email('MAIL_FROM_ADDRESS must be an e-mail address')), 'hello@example.com'),
    MAIL_FROM_NAME: v.optional(v.string(), ''),
    MAIL_HOST: v.optional(v.string(), '127.0.0.1'),
    MAIL_PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(65_535)), '587'),
    /** `true`: TLS from the first byte (port 465). Otherwise STARTTLS when the server offers it. */
    MAIL_SECURE: v.optional(v.pipe(v.picklist(['true', 'false']), v.transform((value) => value === 'true')), 'false'),
    MAIL_USERNAME: v.optional(v.string(), ''),
    MAIL_PASSWORD: v.optional(v.string(), ''),
  }),
  resolve: (env) => ({
    mailer: env.MAIL_MAILER,
    from: env.MAIL_FROM_NAME ? { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME } : env.MAIL_FROM_ADDRESS,
    smtp: { host: env.MAIL_HOST, port: env.MAIL_PORT, secure: env.MAIL_SECURE, username: env.MAIL_USERNAME, password: env.MAIL_PASSWORD },
  }),
});
export type MailConfig = ConfigOf<typeof MailConfig>;

/** Registers the `Mailer` and its `MailTransport` (`MAIL_MAILER`). Found by `bespoke discover`. */
export class MailServiceProvider implements ServiceProvider {
  static config = [MailConfig];

  register(container: Container): void {
    const config = container.make(MailConfig);
    container.singleton(MailTransport, (c) => {
      if (config.mailer === 'array') return new ArrayTransport();
      if (config.mailer === 'smtp') return new SmtpTransport(config.smtp);
      return new LogTransport(c.make(Logger));
    });
    container.singleton(Mailer, (c) => new TransportMailer(c.make(MailTransport), config.from));
  }

  async shutdown(app: Application): Promise<void> {
    const transport = app.container.make(MailTransport);
    if (transport instanceof SmtpTransport) await transport.close();
  }
}
