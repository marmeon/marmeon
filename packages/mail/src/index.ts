import { Application, defineConfig, Logger, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';
import { MailError, Mailer, TransportMailer, type MailQueue } from './mailer.ts';
import { MailPreviews } from './preview.ts';
import { SendQueuedMail } from './queued.ts';
import { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';

// Mail (E29): mails as classes, a transport behind a neutral message type, UI-agnostic content (MJML or HTML).
export { escapeHtml, fromHtml, Html, html, raw, textFromHtml } from './html.ts';
export { fromMjml, Mjml, mjml, MjmlError } from './mjml.ts';
export type { Address, Attachment, Envelope, Mailable, MailContent, MailMessage } from './message.ts';
export { compose, MailError, Mailer, TransportMailer } from './mailer.ts';
export type { MailQueue, QueueMailOptions } from './mailer.ts';
export { fromQueued, SendQueuedMail, toQueued } from './queued.ts';
export type { QueuedMailPayload } from './queued.ts';
export { calendarEvent } from './ics.ts';
export type { CalendarEvent } from './ics.ts';
export { findMailPreviews, MailPreviews } from './preview.ts';
export type { MailPreviewContext, PreviewableMail } from './preview.ts';
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
    NODE_ENV: v.optional(v.string()),
  }),
  resolve: (env) => ({
    mailer: env.MAIL_MAILER,
    from: env.MAIL_FROM_NAME ? { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME } : env.MAIL_FROM_ADDRESS,
    smtp: { host: env.MAIL_HOST, port: env.MAIL_PORT, secure: env.MAIL_SECURE, username: env.MAIL_USERNAME, password: env.MAIL_PASSWORD },
    /**
     * The mail previews under `/_bespoke/mail` (E106): only with `NODE_ENV=development` (E115, W7 step 8) — never "not production":
     * a test, staging or a server without `NODE_ENV` has no such routes.
     */
    previews: env.NODE_ENV === 'development',
  }),
});
export type MailConfig = ConfigOf<typeof MailConfig>;

type QueueModule = typeof import('@bespokecore/queue');

/** @bespokecore/queue is an optional peer: only `mailer.queue()` needs it. */
async function importQueue(): Promise<QueueModule | undefined> {
  try {
    return await import('@bespokecore/queue');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes('@bespokecore/queue')) return undefined;
    throw error;
  }
}

/**
 * Registers the `Mailer` and its `MailTransport` (`MAIL_MAILER`) — built on first use —, the `bespoke.mail` job for
 * `mailer.queue()` when the app has @bespokecore/queue, and with `NODE_ENV=development` only the mail previews
 * (`/_bespoke/mail`, E106, E115). Found by `bespoke discover`.
 */
export class MailServiceProvider implements ServiceProvider {
  static config = [MailConfig];

  /** Whether the transport was built — a web process that only queues mails never opens one, and closes none. */
  #transport: MailTransport | undefined;

  register(container: Container): void {
    const config = container.make(MailConfig);
    container.singleton(MailTransport, (c) => {
      if (config.mailer === 'array') this.#transport = new ArrayTransport();
      else if (config.mailer === 'smtp') this.#transport = new SmtpTransport(config.smtp);
      else this.#transport = new LogTransport(c.make(Logger));
      return this.#transport;
    });
    const queue: MailQueue = async (payload, options) => {
      const module = await importQueue();
      if (!module || !container.has(module.Queue)) {
        throw new MailError('mailer.queue() needs @bespokecore/queue (pnpm add @bespokecore/queue; bespoke discover) — or send the mail now: mailer.send().');
      }
      return container.make(module.Queue).dispatch(SendQueuedMail, payload, options);
    };
    container.singleton(Mailer, (c) => new TransportMailer(() => c.make(MailTransport), config.from, queue, c.make(Application)));
    container.bind(SendQueuedMail, (c) => new SendQueuedMail(c.make(MailTransport), c.make(Application)));
  }

  async boot(app: Application): Promise<void> {
    // The job behind mailer.queue(): a framework job (`bespoke.mail`), registered with the app's jobs.
    const queue = await importQueue();
    if (queue && app.container.has(queue.JobRegistry)) app.container.make(queue.JobRegistry).add([SendQueuedMail], '@bespokecore/mail', { framework: true });

    // Mail previews (E106): only in development (E115) — the devtools link to them.
    if (app.container.make(MailConfig).previews) await registerPreviews(app);
  }

  async shutdown(): Promise<void> {
    if (this.#transport instanceof SmtpTransport) await this.#transport.close();
  }
}

async function registerPreviews(app: Application): Promise<void> {
  let router: typeof import('@bespokecore/router');
  try {
    router = await import('@bespokecore/router');
  } catch {
    return; // no HTTP in this app
  }
  if (!app.container.has(router.Router)) return;
  const previews = new MailPreviews(app.root, app.container, app.container.make(MailConfig).from);
  app.container.instance(MailPreviews, previews);
  // No middleware group: no session, no cookies — a page for the developer's browser only.
  app.container.make(router.Router).load(
    router.defineRoutes((Route) => {
      Route.get('/_bespoke/mail', () => previews.index());
      Route.get('/_bespoke/mail/:module/:mail', (ctx) => previews.show(`${ctx.params.module}/${ctx.params.mail}`, new URL(ctx.request.url)));
    }),
  );
}
