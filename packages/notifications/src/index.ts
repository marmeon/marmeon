import { Application, Clock, defineConfig, Translator, type ConfigOf, type Container, type Resolver, type ServiceProvider, fillPlaceholders } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import * as v from 'valibot';
import { DatabaseChannel, MailChannel, NotificationChannels } from './channels.ts';
import { MakeNotificationsTableCommand, PruneNotificationsCommand } from './commands.ts';
import { Inbox } from './inbox.ts';
import { SendQueuedNotification } from './job.ts';
import type { NotificationClass, RecipientResolvers } from './notification.ts';
import { NotificationDeliverer, Notifications, NotificationSender, type QueueNotification } from './notifications.ts';
import { NotificationRegistry, NotificationSetupError, RecipientRegistry } from './registry.ts';
import { NotificationStore } from './store.ts';

// Notifications (E92, E93): classes with a stable name, a data schema and via(); recipients as data ({ type, id }),
// found again per kind by the modules' resolvers; channels `mail` and `database` — and an open contract for more
// (`live` with @bespokecore/live, Web Push with @bespokecore/pwa); an Inbox always bound to its recipient; a fake.
export type {
  AnyRecipient,
  AnyRecipientResolverClass,
  ChannelsOf,
  CheckNotification,
  DatabaseData,
  DatabaseInput,
  Notification,
  NotificationChannelMap,
  NotificationChannelName,
  NotificationClass,
  NotificationData,
  NotificationInput,
  NotificationInstance,
  NotificationMail,
  NotificationQueueOptions,
  NotificationRecipients,
  NotificationStatics,
  RecipientId,
  RecipientRef,
  RecipientResolver,
  RecipientResolverClass,
  RecipientResolvers,
  Recipients,
  RecipientType,
  RecipientTypeOf,
  SendResult,
} from './notification.ts';
export { DatabaseChannel, MailChannel, NotificationChannels } from './channels.ts';
export type { ChannelFactory, Delivery, NotificationChannel, QueueMail } from './channels.ts';
export { checkSend, NotificationChannelError, NotificationDeliverer, Notifications, NotificationSender } from './notifications.ts';
export type { DelivererDependencies, DeliveryOutcome, PendingDelivery, QueueNotification, SendData, SendOptions } from './notifications.ts';
export { checkNotificationClass, NotificationError, NotificationRegistry, NotificationSetupError, RecipientRegistry } from './registry.ts';
export { Inbox, notificationData } from './inbox.ts';
export { isNotificationId, NOTIFICATIONS_TABLE, NotificationStore } from './store.ts';
export type { StoredNotification } from './store.ts';
export { SendQueuedNotification } from './job.ts';
export type { QueuedNotificationPayload } from './job.ts';
export { NotificationFake } from './fake.ts';
export type { NotificationMatch, SentNotification } from './fake.ts';
export { MakeNotificationsTableCommand, NOTIFICATIONS_MIGRATION, PruneNotificationsCommand } from './commands.ts';
export { describeIssues, NotificationDataError } from './validate.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** The module's notifications — classes with `static notification`, `static schema` and `via()`. Only registered ones can be sent. */
    readonly notifications?: readonly NotificationClass[];
    /** How the module's kinds of recipients are found again where a notification is delivered: `{ user: UserRecipients }`. */
    readonly recipients?: RecipientResolvers;
  }
}

/**
 * Notifications:
 *
 * ```sh
 * NOTIFICATIONS_CONNECTION=default   # the database connection of the `notifications` table (bespoke make:notifications-table)
 * ```
 */
export const NotificationConfig = defineConfig('notifications', {
  env: v.object({
    NOTIFICATIONS_CONNECTION: v.optional(v.pipe(v.string(), v.nonEmpty()), 'default'),
  }),
  resolve: (env) => ({ connection: env.NOTIFICATIONS_CONNECTION }),
});
export type NotificationConfig = ConfigOf<typeof NotificationConfig>;

type QueueModule = typeof import('@bespokecore/queue');
type MailModule = typeof import('@bespokecore/mail');
type I18nModule = typeof import('@bespokecore/i18n');

/** An optional peer — undefined when it is not installed. */
async function importOptional<T>(load: () => Promise<T>, name: string): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(name)) return undefined;
    throw error;
  }
}

/**
 * Registers `Notifications` (`send` through the queue, `sendNow`), the `Inbox`, the channels `database` and — with
 * @bespokecore/mail — `mail`, the modules' notifications and recipient resolvers (checked at startup), the
 * `bespoke.notification` job and the `notifications:*` commands. Found by `bespoke discover`.
 */
export class NotificationServiceProvider implements ServiceProvider {
  static config = [NotificationConfig];

  #queue: QueueModule | undefined;
  #i18n: I18nModule | undefined;

  register(container: Container): void {
    container.singleton(NotificationRegistry, (c) => {
      const registry = new NotificationRegistry();
      for (const module of c.make(Application).modules) registry.add(module.notifications ?? [], `module ${module.name}`);
      return registry;
    });
    container.singleton(RecipientRegistry, (c) => {
      const registry = new RecipientRegistry();
      for (const module of c.make(Application).modules) registry.add((module.recipients ?? {}) as Record<string, never>, `module ${module.name}`);
      return registry;
    });
    container.singleton(NotificationStore, (c) => new NotificationStore(c.make(Connections), c.make(NotificationConfig).connection, c.make(Clock)));
    container.singleton(Inbox, (c) => new Inbox(c.make(NotificationStore)));
    container.singleton(NotificationChannels, (c) => new NotificationChannels().add('database', () => new DatabaseChannel(c.make(NotificationStore))));
    container.singleton(
      NotificationDeliverer,
      (c) =>
        new NotificationDeliverer({
          recipients: c.make(RecipientRegistry),
          channels: c.make(NotificationChannels),
          store: c.make(NotificationStore),
          connections: c.make(Connections),
          translator: (locale, scope) => this.#translator(container, locale, scope),
          app: c.make(Application),
        }),
    );
    const queue: QueueNotification = async (pending, options) => {
      const module = this.#queue;
      if (!module || !container.has(module.Queue)) {
        throw new NotificationSetupError('notifications.send() queues the delivery and needs @bespokecore/queue (pnpm add @bespokecore/queue; bespoke discover) — or deliver now: notifications.sendNow().');
      }
      const { queue: name, connection, delay, tries, backoff } = pending.notification.queue ?? {};
      const when = options.delay ?? delay;
      const dispatch = {
        ...(name === undefined ? {} : { queue: name }),
        ...(connection === undefined ? {} : { connection }),
        ...(when === undefined ? {} : { delay: when }),
        // The notification's own tries and backoff, for its job (like a queued listener's).
        [module.RECORD_OPTIONS]: { ...(tries === undefined ? {} : { tries }), ...(backoff === undefined ? {} : { backoff: typeof backoff === 'number' ? [backoff] : backoff }) },
      };
      // Like any dispatch (E107): inside a transaction it exists with the commit — a database queue writes it into it.
      await container
        .make(module.Queue)
        .dispatch(SendQueuedNotification as never, { id: pending.id, notification: pending.notification.notification, recipient: pending.recipient, data: pending.data } as never, dispatch);
    };
    // Per resolution, bound to the container that asks: `sendNow` in a request builds the notification and the resolver
    // from the request's scope.
    container.bind(Notifications, (c) => new NotificationSender(c, c.make(NotificationRegistry), c.make(RecipientRegistry), () => c.make(NotificationDeliverer), queue, c.make(Application)));
    container.bind(SendQueuedNotification, (c) => new SendQueuedNotification(c, c.make(NotificationDeliverer), c.make(NotificationRegistry)));
    container.bind(PruneNotificationsCommand, (c) => new PruneNotificationsCommand(c.make(NotificationStore), c.make(Clock)));
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    // Two notifications with one name, a class without one, two resolvers for one kind: the start fails.
    const registry = container.make(NotificationRegistry);
    container.make(RecipientRegistry);
    if (!container.has(Connections)) {
      throw new NotificationSetupError('Notifications keep their rows in the database — register the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).');
    }
    // An unknown connection name fails here, with the known ones.
    container.make(Connections).options(container.make(NotificationConfig).connection);

    // The mail channel: a mail composed in the recipient's language and queued (mailer.queue, E105).
    const mail: MailModule | undefined = await importOptional(() => import('@bespokecore/mail'), '@bespokecore/mail');
    if (mail && container.has(mail.Mailer)) {
      container.make(NotificationChannels).add('mail', (scope) => new MailChannel((message, options) => scope.make(mail.Mailer).queue(message as never, options)));
    }
    this.#i18n = await importOptional(() => import('@bespokecore/i18n'), '@bespokecore/i18n');

    // The job behind send(): a framework job (`bespoke.notification`) — registered only when the app has notifications.
    this.#queue = await importOptional(() => import('@bespokecore/queue'), '@bespokecore/queue');
    if (this.#queue && container.has(this.#queue.JobRegistry) && registry.all().length > 0) {
      container.make(this.#queue.JobRegistry).add([SendQueuedNotification as never], '@bespokecore/notifications', { framework: true });
    }

    const cli = await import('@bespokecore/cli').catch(() => undefined);
    if (cli && container.has(cli.CommandRegistry)) container.make(cli.CommandRegistry).add([PruneNotificationsCommand, MakeNotificationsTableCommand]);
  }

  /** A translator in the recipient's language — `Translators.for(locale)` of @bespokecore/i18n; without it, the scope's (or English fallbacks). */
  #translator(root: Container, locale: string | null | undefined, scope: Resolver): Translator {
    const i18n = this.#i18n;
    if (i18n && root.has(i18n.Translators)) return root.make(i18n.Translators).for(locale);
    if (root.has(Translator)) {
      try {
        return scope.make(Translator);
      } catch {
        // Bound per request only — not in this scope.
      }
    }
    return { locale: locale ?? 'en', has: () => false, text: (key, params, fallback) => fillPlaceholders(fallback ?? key, params) };
  }
}
