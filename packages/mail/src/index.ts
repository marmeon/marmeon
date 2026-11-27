import { Application, Clock, Logger, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { devOnly } from '@marmeon/core/dev';
import { API_MAIL_DRIVERS, BUILT_IN_MAIL_DRIVERS, fromDefaultWarning, LOG_MAILER_WARNING, MailConfig, POSTMARK_TEST_TOKEN, POSTMARK_TEST_TOKEN_WARNING } from './config.ts';
import { MailError, Mailer, MailSetupError, TransportMailer, type MailQueue } from './mailer.ts';
import { importFetch, type FetchModule } from './drivers/api.ts';
import { MailPreviews } from './preview.ts';
import { SendQueuedMail } from './queued.ts';
import { PostmarkTransport } from './drivers/postmark.ts';
import { ArrayTransport, LogTransport, MailTransport, SmtpTransport, type MailDriverFactory } from './transports.ts';

export { fromHtml, Html, html, raw } from './html.ts';
export { fromMjml, Mjml, mjml, MjmlError } from './mjml.ts';
export type { Address, Attachment, Envelope, Mailable, MailContent, MailMessage } from './message.ts';
export { MailConfig } from './config.ts';
export { MailDeliveryError, MailError, Mailer, MailSetupError } from './mailer.ts';
export type { MailDeliveryReason, QueueMailOptions, SentMail } from './mailer.ts';
export { calendarEvent } from './ics.ts';
export type { CalendarEvent } from './ics.ts';
export type { MailPreviewContext } from './preview.ts';
export { MailTransport } from './transports.ts';
export type { MailDriverContext, MailDriverFactory, MailReceipt, MailSendOptions } from './transports.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Mail transports this provider brings, by name — `MAIL_DRIVER=<name>` selects one. A built-in name (`log`, `array`, `smtp`, `postmark`) or a
     * name another provider brings stops the start. See `docs/drivers.md#mail-transports`.
     */
    readonly mailDrivers?: Readonly<Record<string, MailDriverFactory>>;
  }
}

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
  /** @marmeon/fetch, loaded at boot when an API driver is chosen: the transport is built synchronously, after it. */
  #fetch: FetchModule | undefined;

  register(container: Container): void {
    const config = container.make(MailConfig);
    container.singleton(MailTransport, (c) => {
      if (config.driver === 'array') this.#transport = new ArrayTransport();
      else if (config.driver === 'smtp') this.#transport = new SmtpTransport(config.smtp);
      else if (config.driver === 'log') this.#transport = new LogTransport(c.make(Logger), { text: !config.protected });
      else if (config.driver === 'postmark') this.#transport = this.#postmark(config, c);
      else this.#transport = this.#custom(config, c);
      return this.#transport;
    });
    const queue: MailQueue = async (payload, options) => {
      const module = await importQueue();
      if (!module || !container.has(module.Queue)) {
        throw new MailError('mailer.queue() needs @marmeon/queue (marmeon add queue; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/queue@<version of your app>) — or send the mail now: mailer.send().');
      }
      return container.make(module.Queue).dispatch(SendQueuedMail, payload, options);
    };
    container.singleton(Mailer, (c) => new TransportMailer(() => c.make(MailTransport), config.from, queue, c.make(Application)));
    container.bind(SendQueuedMail, (c) => new SendQueuedMail(c.make(MailTransport), c.make(Application)));
  }

  /** The Postmark transport; the `HttpClient` is resolved for every request, so `app.http` of a test app is the one used. */
  #postmark(config: MailConfig, container: Resolver): MailTransport {
    const module = this.#fetch;
    // `boot()` loads @marmeon/fetch (or stops the start) before it builds the transport; unset means something asked for it earlier.
    if (!module) {
      throw new MailSetupError(withCode('Q8', 'The mail transport was resolved before MailServiceProvider booted, so @marmeon/fetch is not loaded yet. Resolve MailTransport or Mailer after the application has started.'));
    }
    return new PostmarkTransport({ token: config.postmark.token, http: () => container.make(module.HttpClient), fetch: module, clock: container.make(Clock) });
  }

  #fetchMissing(): MailSetupError {
    return new MailSetupError(
      withCode('Q8', 'MAIL_DRIVER=postmark sends through @marmeon/fetch (marmeon add fetch; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/fetch@<version of your app>).'),
    );
  }

  /** The checks of an API driver, before its transport is built: @marmeon/fetch is there and bound, and the credential is set (its value is never named). */
  async #checkApiDriver(app: Application, config: MailConfig): Promise<void> {
    const module = await importFetch();
    if (!module) throw this.#fetchMissing();
    if (!app.container.has(module.HttpClient)) {
      throw new MailSetupError(withCode('Q8', `MAIL_DRIVER=${config.driver} sends through the HttpClient of @marmeon/fetch, which this app does not register. Run marmeon discover (or add FetchServiceProvider to the app's providers).`));
    }
    if (config.driver === 'postmark' && config.postmark.token.trim() === '') {
      throw new MailSetupError(withCode('Q8', 'MAIL_DRIVER=postmark needs MAIL_POSTMARK_TOKEN (the server API token of your Postmark server).'));
    }
    this.#fetch = module;
  }

  #factories(container: Resolver): ReadonlyMap<string, MailDriverFactory> {
    return collectDrivers<MailDriverFactory>(container.make(Application).providers, 'mailDrivers', BUILT_IN_MAIL_DRIVERS, 'mail driver');
  }

  /** The transport a provider's factory returns for `MAIL_DRIVER`; a name nobody brought is refused (a typo never lands on another transport). */
  #custom(config: MailConfig, container: Resolver): MailTransport {
    const factory = this.#factories(container).get(config.driver);
    if (!factory) throw this.#unknown(config.driver, container);
    const transport = factory({ name: config.driver, container, logger: container.make(Logger).child({ channel: 'mail' }) });
    if (typeof (transport as Partial<MailTransport> | undefined)?.send !== 'function') {
      throw new MailSetupError(withCode('Q8', `The mail driver "${config.driver}" must return a MailTransport: an object with send(message) that resolves with { messageId }.`));
    }
    return transport;
  }

  #unknown(driver: string, container: Resolver): MailSetupError {
    return new MailSetupError(withCode('Q8', `MAIL_DRIVER=${driver} is not a mail driver. Known: ${[...BUILT_IN_MAIL_DRIVERS, ...this.#factories(container).keys()].join(', ')}.`));
  }

  async boot(app: Application): Promise<void> {
    const config = app.container.make(MailConfig);
    // A name nobody brought, a built-in name or a name twice stops the start here; so does a factory that fails.
    const custom = this.#factories(app.container);
    if (API_MAIL_DRIVERS.includes(config.driver)) {
      await this.#checkApiDriver(app, config);
      app.container.make(MailTransport);
    } else if (!(BUILT_IN_MAIL_DRIVERS as readonly string[]).includes(config.driver)) {
      if (!custom.has(config.driver)) throw this.#unknown(config.driver, app.container);
      app.container.make(MailTransport);
    }
    const queue = await importQueue();
    if (queue && app.container.has(queue.JobRegistry)) app.container.make(queue.JobRegistry).add([SendQueuedMail], '@marmeon/mail', { framework: true });

    // Production on the log mailer: no mail goes out, and the log gets only recipients and subjects — said once, at boot.
    if (config.protected && config.driver === 'log') app.container.make(Logger).warn(LOG_MAILER_WARNING, { driver: 'log' });
    if (config.protected && config.driver === 'postmark' && config.postmark.token.trim() === POSTMARK_TEST_TOKEN) {
      app.container.make(Logger).warn(POSTMARK_TEST_TOKEN_WARNING, { driver: 'postmark' });
    }
    if (config.protected && config.fromDefaulted) app.container.make(Logger).warn(fromDefaultWarning(config.driver), { driver: config.driver });
    if (config.previews) await registerPreviews(app);
  }

  async shutdown(): Promise<void> {
    await this.#transport?.close?.();
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
