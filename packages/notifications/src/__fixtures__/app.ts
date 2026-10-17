import { Clock, createApplication, Logger, type Application, type ModuleDefinition } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, Schema, sql } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { Mailer, MailServiceProvider, type Mailable } from '@marmeon/mail';
import { MailFake } from '@marmeon/mail/testing';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QUEUE_MIGRATION } from '@marmeon/queue/internal';
import { QueueFake } from '@marmeon/queue/testing';
import * as v from 'valibot';
import { NOTIFICATIONS_MIGRATION } from '../commands.ts';
import { NotificationServiceProvider } from '../index.ts';
import type { DatabaseInput, Notification, NotificationData, RecipientResolver } from '../notification.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);
export type TestDriver = (typeof drivers)[number];

export const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

export interface Member {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly verified: boolean;
  readonly locale: string;
}

declare module '../notification.ts' {
  interface NotificationRecipients {
    member: Member;
    team: { readonly id: string; readonly name: string };
  }
}

export const MEMBERS = new Map<number, Member>([
  [1, { id: 1, name: 'Ada', email: 'ada@example.com', verified: true, locale: 'de' }],
  [2, { id: 2, name: 'Alan', email: 'alan@example.com', verified: false, locale: 'en' }],
  [3, { id: 3, name: 'Grace', email: 'grace@example.com', verified: true, locale: 'en' }],
]);

/** Finds members — and says their language. */
export class Members implements RecipientResolver<'member'> {
  async find(id: number): Promise<Member | undefined> {
    return MEMBERS.get(id);
  }

  locale(member: Member): string {
    return member.locale;
  }
}

export class ShippedMail implements Mailable {
  readonly member: Member;
  readonly orderId: string;
  readonly locale: string;

  constructor(member: Member, orderId: string, locale: string) {
    this.member = member;
    this.orderId = orderId;
    this.locale = locale;
  }

  envelope() {
    return { to: this.member.email, subject: `${this.locale === 'de' ? 'Versandt' : 'Shipped'}: ${this.orderId}` };
  }

  content() {
    return { html: `<p>${this.orderId}</p>`, text: this.orderId };
  }
}

/** Database for everyone, a mail only for verified members. */
export class OrderShipped implements Notification<'member'> {
  static readonly notification = 'shop.order-shipped';
  static readonly schema = v.object({ orderId: v.string(), carrier: v.optional(v.string()) });
  static readonly database = v.object({ orderId: v.string() });
  static readonly queue = { queue: 'mail', tries: 2, backoff: 5 };

  via(member: Member) {
    return member.verified ? (['database', 'mail'] as const) : (['database'] as const);
  }

  toDatabase(data: NotificationData<typeof OrderShipped>): DatabaseInput<typeof OrderShipped> {
    return { orderId: data.orderId };
  }

  toMail(member: Member, data: NotificationData<typeof OrderShipped>, t: { readonly locale: string }) {
    return new ShippedMail(member, data.orderId, t.locale);
  }
}

/** Only a row. */
export class Welcome implements Notification<'member'> {
  static readonly notification = 'shop.welcome';
  static readonly schema = v.object({ code: v.string() });
  static readonly database = v.object({ code: v.string() });

  via() {
    return ['database'] as const;
  }

  toDatabase(data: NotificationData<typeof Welcome>) {
    return { code: data.code };
  }
}

/** A channel nobody has. */
export class Faxed {
  static readonly notification = 'shop.faxed';
  static readonly schema = v.object({});

  via() {
    return ['fax'];
  }
}

export interface TestApp extends Application {
  readonly clock: TestClock;
  readonly mail: MailFake;
  readonly queue: QueueFake | undefined;
  readonly connections: Connections;
  close(): Promise<void>;
}

/** A fresh database per app: SQLite in memory, or a new Postgres database (dropped by `close()`). */
async function freshDatabase(driver: TestDriver): Promise<{ env: Record<string, string>; drop: () => Promise<void> }> {
  if (driver === 'sqlite') return { env: { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, drop: async () => {} };
  const name = `marmeon_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  return {
    env: { DB_MANAGED: 'false', DB_CONNECTION: 'pgsql', DB_URL: url.href, DB_POOL_MAX: '3' },
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/**
 * An app with notifications, mail (faked), a queue (faked unless `queue: 'database'`) and the members resolver, migrated:
 * `notifications`, `jobs`.
 */
export async function notificationApp(
  driver: TestDriver,
  options: { notifications?: ModuleDefinition['notifications']; recipients?: ModuleDefinition['recipients']; queue?: 'fake' | 'database' } = {},
): Promise<TestApp> {
  const database = await freshDatabase(driver);
  const clock = new TestClock();
  const mail = new MailFake();
  let queue: QueueFake | undefined;
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider, MailServiceProvider, NotificationServiceProvider],
    modules: [{ name: 'shop', notifications: options.notifications ?? [OrderShipped, Welcome], recipients: options.recipients ?? { member: Members } }],
  }, {
    env: { ...database.env, APP_KEY: KEY, NODE_ENV: 'test' },
    override: (container) => {
      container.instance(Clock, clock);
      container.instance(Logger, silent);
      container.instance(Mailer, mail);
      if (options.queue !== 'database') {
        queue = new QueueFake(container);
        container.instance(Queue, queue);
      }
    },
  });
  const connections = application.container.make(Connections);
  const schema = new Schema(connections.get(), connections.options().driver);
  for (const file of [NOTIFICATIONS_MIGRATION, QUEUE_MIGRATION]) {
    const migration = ((await import(file.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
    await migration.up(schema);
  }
  return Object.assign(application, {
    clock,
    mail,
    queue,
    connections,
    close: async () => {
      await application.shutdown();
      await database.drop();
    },
  });
}
