import { Application, defineConfig, env, environment, Logger, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';
import { devHosts, devOnly } from '@marmeon/core/dev';
import { MailError, Mailer, TransportMailer, type MailQueue } from './mailer.ts';
import { MailPreviews } from './preview.ts';
import { SendQueuedMail } from './queued.ts';
import { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';

export { escapeHtml, fromHtml, Html, html, raw, textFromHtml } from './html.ts';
export { fromMjml, Mjml, mjml, MJML_INSTALL, MjmlError } from './mjml.ts';
export type { Address, Attachment, Envelope, Mailable, MailContent, MailMessage } from './message.ts';
export { compose, MailError, Mailer, TransportMailer } from './mailer.ts';
export type { MailQueue, QueueMailOptions } from './mailer.ts';
export { fromQueued, SendQueuedMail, toQueued } from './queued.ts';
export type { QueuedMailAddress, QueuedMailMessage, QueuedMailPayload } from './queued.ts';
export { calendarEvent } from './ics.ts';
export type { CalendarEvent } from './ics.ts';
export { findMailPreviews, MailPreviews } from './preview.ts';
export type { MailPreviewContext, PreviewableMail } from './preview.ts';
export { MailFake } from './fake.ts';
export { ArrayTransport, LogTransport, MailTransport, SmtpTransport } from './transports.ts';
export type { SmtpOptions } from './transports.ts';

export const MailConfig = defineConfig('mail', {
  env: env({
    /** `log` (default: written to the log, nothing is sent), `array` (kept in memory) or `smtp` (nodemailer, a dependency of this package). */
    MAIL_MAILER: env.in(['log', 'array', 'smtp']).default('log'),
    MAIL_FROM_ADDRESS: env.email('MAIL_FROM_ADDRESS must be an e-mail address').default('hello@example.com'),
    MAIL_FROM_NAME: env.string().default(''),
    MAIL_HOST: env.string().default('127.0.0.1'),
    MAIL_PORT: env.port().default(587),
    /** `true`: TLS from the first byte (port 465). Otherwise STARTTLS (required unless MAIL_REQUIRE_TLS=false). */
    MAIL_SECURE: env.in(['true', 'false']).default('false'),
    // Without MAIL_SECURE: STARTTLS or no mail — `false` only for a local server without TLS (Mailpit).
    MAIL_REQUIRE_TLS: env.in(['true', 'false']).default('true'),
    MAIL_USERNAME: env.string().default(''),
    MAIL_PASSWORD: env.string().default(''),
    NODE_ENV: env.string().optional(),
    APP_URL: env.string().optional(),
  }),
  resolve: (e) => ({
    mailer: e.MAIL_MAILER,
    from: e.MAIL_FROM_NAME ? { address: e.MAIL_FROM_ADDRESS, name: e.MAIL_FROM_NAME } : e.MAIL_FROM_ADDRESS,
    smtp: {
      host: e.MAIL_HOST,
      port: e.MAIL_PORT,
      secure: e.MAIL_SECURE === 'true',
      requireTls: e.MAIL_REQUIRE_TLS === 'true',
      username: e.MAIL_USERNAME,
      password: e.MAIL_PASSWORD,
    },
    /** The mail previews under `/_marmeon/mail`: only with `NODE_ENV=development`, never "not production". */
    previews: environment.isDevelopment(e),
    /** The hosts the previews answer (DNS rebinding): loopback names and `APP_URL`'s; any other gets 403. */
    previewHosts: devHosts(e.APP_URL),
    /** Protected (production, or no `NODE_ENV`): the boot warns about `MAIL_MAILER=log` ({@link LOG_MAILER_WARNING}). */
    protected: environment.isProtected(e),
  }),
});
export type MailConfig = ConfigOf<typeof MailConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs on the
 * `log` mailer — the default when `MAIL_MAILER` is not set.
 * The log mailer stays as it is everywhere: in development the links of a mail are clicked from the log.
 */
export const LOG_MAILER_WARNING =
  'MAIL_MAILER=log outside development and tests: no mail is sent — every mail is written to the log instead, its links and tokens (password ' +
  'reset, e-mail verification, signed URLs) in plain text. Set MAIL_MAILER=smtp and MAIL_HOST, ' +
  'MAIL_USERNAME, MAIL_PASSWORD.';

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
 * Registers the `Mailer` and its `MailTransport` (`MAIL_MAILER`) — built on first use —, the `marmeon.mail` job for
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
