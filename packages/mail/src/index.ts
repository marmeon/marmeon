import { Application, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { devOnly } from '@marmeon/core/dev';
import { LOG_MAILER_WARNING, MailConfig } from './config.ts';
import { MailError, Mailer, TransportMailer, type MailQueue } from './mailer.ts';
import { MailPreviews } from './preview.ts';
import { SendQueuedMail } from './queued.ts';
import { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';

export { fromHtml, Html, html, raw } from './html.ts';
export { fromMjml, Mjml, mjml, MjmlError } from './mjml.ts';
export type { Address, Attachment, Envelope, Mailable, MailContent, MailMessage } from './message.ts';
export { MailConfig } from './config.ts';
export { compose, MailError, Mailer } from './mailer.ts';
export type { QueueMailOptions } from './mailer.ts';
export { calendarEvent } from './ics.ts';
export type { CalendarEvent } from './ics.ts';
export type { MailPreviewContext } from './preview.ts';
export { MailTransport } from './transports.ts';

type QueueModule = typeof import('@marmeon/queue');

/** @marmeon/queue is an optional peer: only `mailer.queue()` needs it. */
async function importQueue(): Promise<QueueModule | undefined> {
  try {
    return await import('@marmeon/queue');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes('@marmeon/queue')) return undefined;
    throw error;
  }
}

/**
 * Registers the `Mailer` and its `MailTransport` (`MAIL_DRIVER`) — built on first use —, the `marmeon.mail` job for
 * `mailer.queue()` when the app has @marmeon/queue, and with `NODE_ENV=development` only the mail previews
 * (`/_marmeon/mail`). Found by `marmeon discover`.
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
        throw new MailError('mailer.queue() needs @marmeon/queue (pnpm add @marmeon/queue; marmeon discover) — or send the mail now: mailer.send().');
      }
      return container.make(module.Queue).dispatch(SendQueuedMail, payload, options);
    };
    container.singleton(Mailer, (c) => new TransportMailer(() => c.make(MailTransport), config.from, queue, c.make(Application)));
    container.bind(SendQueuedMail, (c) => new SendQueuedMail(c.make(MailTransport), c.make(Application)));
  }

  async boot(app: Application): Promise<void> {
    const queue = await importQueue();
    if (queue && app.container.has(queue.JobRegistry)) app.container.make(queue.JobRegistry).add([SendQueuedMail], '@marmeon/mail', { framework: true });

    const config = app.container.make(MailConfig);
    // Production on the log mailer: no mail goes out, and reset links land in the log — said once, at boot.
    if (config.protected && config.mailer === 'log') app.container.make(Logger).warn(LOG_MAILER_WARNING, { mailer: 'log' });
    if (config.previews) await registerPreviews(app);
  }

  async shutdown(): Promise<void> {
    if (this.#transport instanceof SmtpTransport) await this.#transport.close();
  }
}

async function registerPreviews(app: Application): Promise<void> {
  let router: typeof import('@marmeon/router');
  let internal: typeof import('@marmeon/router/internal');
  try {
    router = await import('@marmeon/router');
    internal = await import('@marmeon/router/internal');
  } catch {
    return; // no HTTP in this app
  }
  if (!app.container.has(router.Router)) return;
  const config = app.container.make(MailConfig);
  const previews = new MailPreviews(app.root, app.container, config.from);
  app.container.instance(MailPreviews, previews);
  const hosts = config.previewHosts;
  // No middleware group: no session, no cookies — a page for the developer's browser only. Behind the guard of every development
  // route: 403 for any host but loopback and APP_URL's (DNS rebinding), `no-store`, CORP/COOP same-origin, no CORS.
  app.container.make(router.Router).load(
    { framework: internal.FRAMEWORK_ROUTES },
    router.defineRoutes((Route) => {
      Route.get('/_marmeon/mail', devOnly(hosts, () => previews.index()));
      Route.get('/_marmeon/mail/:module/:mail', devOnly(hosts, (ctx) => previews.show(`${ctx.params.module}/${ctx.params.mail}`, new URL(ctx.request.url))));
    }),
  );
}
