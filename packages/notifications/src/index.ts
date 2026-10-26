import { Application, Clock, Translator, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import type { ProviderMigrations } from '@marmeon/database';
import { fillPlaceholders } from '@marmeon/core/internal';
import { Connections } from '@marmeon/database';
import type { CommandClass } from 'marmeon';
import { DatabaseChannel, MailChannel, NotificationChannels } from './channels.ts';
import { MakeNotificationsTableCommand, PruneNotificationsCommand } from './commands.ts';
import { NotificationConfig } from './config.ts';
import { Inbox } from './inbox.ts';
import { heldReason, SendQueuedNotification } from './job.ts';
import type { NotificationClass, RecipientResolvers } from './notification.ts';
import { NotificationDeliverer, Notifications, NotificationSender, type QueueNotification } from './notifications.ts';
import { backoffSeconds, NotificationRegistry, NotificationSetupError, RecipientRegistry } from './registry.ts';
import { NOTIFICATIONS_COLUMNS, NOTIFICATIONS_TABLE, NotificationStore } from './store.ts';
import { withCode } from '@marmeon/core/internal';

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
export { NotificationConfig } from './config.ts';
export { NotificationChannels } from './channels.ts';
export type { ChannelFactory, Delivery, NotificationChannel } from './channels.ts';
export { NotificationChannelError, Notifications } from './notifications.ts';
export type { DeliveryOutcome, SendData, SendOptions } from './notifications.ts';
export { NotificationError, NotificationSetupError } from './registry.ts';
export { Inbox, notificationData } from './inbox.ts';
export { NotificationStore } from './store.ts';
export type { StoredNotification } from './store.ts';
export { SendQueuedNotification } from './job.ts';
export type { QueuedNotificationPayload } from './job.ts';
export { NotificationDataError } from './validate.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The module's notifications — classes with `static notification`, `static schema` and `via()`. Only registered ones can be sent. */
    readonly notifications?: readonly NotificationClass[];
    /** How the module's kinds of recipients are found again where a notification is delivered: `{ user: UserRecipients }`. */
    readonly recipients?: RecipientResolvers;
  }
}

/**
 * The connection the `notifications` table belongs on — for the migration `marmeon make:notifications-table` writes
 * (`connection` in `defineMigration`): `NOTIFICATIONS_CONNECTION`, where the database channel and the Inbox look.
 */
export function notificationsTableConnection(container: Resolver): string {
  return container.make(NotificationConfig).connection;
}

type QueueModule = typeof import('@marmeon/queue') & typeof import('@marmeon/queue/internal');
type MailModule = typeof import('@marmeon/mail');
type I18nModule = typeof import('@marmeon/i18n');

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
 * @marmeon/mail — `mail`, the modules' notifications and recipient resolvers (checked at startup), the
 * `marmeon.notification` job and the `notifications:*` commands. Found by `marmeon discover`.
 */
export class NotificationServiceProvider implements ServiceProvider {
  static config = [NotificationConfig];
  static commands: readonly CommandClass[] = [PruneNotificationsCommand, MakeNotificationsTableCommand];
  /** The migrations for the notifications table, which `marmeon publish` and the `make:*-table` command copy into the app. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;

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
        throw new NotificationSetupError(withCode('Q6', 'notifications.send() queues the delivery and needs @marmeon/queue (pnpm add @marmeon/queue; marmeon discover) — or deliver now: notifications.sendNow().'));
      }
      const { queue: name, connection, delay, tries, backoff } = pending.notification.queue ?? {};
      const when = options.delay ?? delay;
      const dispatch = {
        ...(name === undefined ? {} : { queue: name }),
        ...(connection === undefined ? {} : { connection }),
        ...(when === undefined ? {} : { delay: when }),
        // The notification's own tries and backoff, for its job (like a queued listener's).
        [module.RECORD_OPTIONS]: { ...(tries === undefined ? {} : { tries }), ...(backoff === undefined ? {} : { backoff: backoffSeconds(backoff) }) },
      };
      // Like any dispatch: inside a transaction it exists with the commit — a database queue writes it into it.
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
      throw new NotificationSetupError(withCode('Q6', 'Notifications keep their rows in the database — register the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).'));
    }
    // An unknown connection name fails here, with the known ones.
    const connection = container.make(NotificationConfig).connection;
    container.make(Connections).options(connection);
    // Only a notification with `static database` is delivered to the table (and the Inbox reads only those rows): then /up/ready is red
    // until the table has the new name and every column the store uses.
    if (registry.all().some((notification) => notification.database !== undefined)) {
      const { SchemaRequirements } = await import('@marmeon/database');
      container.make(SchemaRequirements).require({ connection, table: NOTIFICATIONS_TABLE, columns: NOTIFICATIONS_COLUMNS });
    }

    const mail: MailModule | undefined = await importOptional(() => import('@marmeon/mail'), '@marmeon/mail');
    if (mail && container.has(mail.Mailer)) {
      container.make(NotificationChannels).add('mail', (scope) => new MailChannel((message, options) => scope.make(mail.Mailer).queue(message as never, options)));
    }
    this.#i18n = await importOptional(() => import('@marmeon/i18n'), '@marmeon/i18n');

    // The job behind send(): a framework job (`marmeon.notification`) — registered only when the app has notifications.
    this.#queue = await importOptional(async () => ({ ...(await import('@marmeon/queue')), ...(await import('@marmeon/queue/internal')) }), '@marmeon/queue');
    if (this.#queue && container.has(this.#queue.JobRegistry) && registry.all().length > 0) {
      (SendQueuedNotification as unknown as Record<symbol, unknown>)[this.#queue.TARGET_UNKNOWN] = heldReason;
      container.make(this.#queue.JobRegistry).add([SendQueuedNotification as never], '@marmeon/notifications', { framework: true });
    }
  }

  /** A translator in the recipient's language — `Translators.for(locale)` of @marmeon/i18n; without it, the scope's (or English fallbacks). */
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
