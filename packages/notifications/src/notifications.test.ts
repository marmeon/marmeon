import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, InvalidCursorError, sql } from '@marmeon/database';
import { Encrypter } from '@marmeon/encryption';
import { Queue } from '@marmeon/queue';
import { afterEach, describe, expect, it } from 'vitest';
import { drivers, Faxed, KEY, Members, notificationApp, OrderShipped, ShippedMail, silent, Welcome, type TestApp } from './__fixtures__/app.ts';
import { Inbox, notificationData } from './inbox.ts';
import { NotificationFake } from './fake.ts';
import { SendQueuedNotification } from './job.ts';
import { NotificationDeliverer, Notifications } from './notifications.ts';
import { NotificationServiceProvider, PruneNotificationsCommand } from './index.ts';
import { NotificationSetupError } from './registry.ts';
import { NotificationStore } from './store.ts';

const ada = { type: 'member', id: 1 } as const;
const alan = { type: 'member', id: 2 } as const;
const grace = { type: 'member', id: 3 } as const;

let open: TestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function app(...args: Parameters<typeof notificationApp>): Promise<TestApp> {
  open = await notificationApp(...args);
  return open;
}

/** The rows of `notifications`, oldest first. */
async function rows(application: TestApp) {
  const result = await sql<{ id: string; recipient_type: string; recipient_id: string; type: string; data: unknown; read_at: string | null }>`select * from notifications order by created_at, id`.execute(
    application.connections.get(),
  );
  return result.rows;
}

const output = () => {
  const lines: string[] = [];
  const push = (line: string) => void lines.push(line);
  return { lines, output: { line: push, success: push, error: push, warn: push, info: push } as never };
};

describe.each(drivers)('notifications on %s', (driver) => {
  describe('send → marmeon.notification → channels', () => {
    it('queues one encrypted job per recipient, then a worker writes the row and queues the mail in the recipient\'s language', async () => {
      const application = await app(driver);
      const notifications = application.container.make(Notifications);
      const id = await notifications.send(ada, OrderShipped, { orderId: 'o-1' });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      application.queue!.assertDispatched(SendQueuedNotification, { notification: 'shop.order-shipped', recipient: { type: 'member', id: 1 } });
      // On the notification's queue, with its own tries.
      expect(application.queue!.dispatched(SendQueuedNotification)[0]!.queue).toBe('mail');
      expect(await rows(application)).toEqual([]);

      const result = await application.queue!.work();
      expect(result.failed).toBe(0);
      const [row] = await rows(application);
      expect(row).toMatchObject({ id, recipient_type: 'member', recipient_id: '1', type: 'shop.order-shipped', data: { orderId: 'o-1' }, read_at: null });
      // Ada reads German (her resolver's locale) — whatever language the sender had.
      application.mail.assertQueued(ShippedMail, (mail, message, options) => message.subject === 'Versandt: o-1' && options.queue === 'mail' && mail.member.id === 1);
    });

    it('sends no mail to whom via() leaves it out — an unverified member gets the row only', async () => {
      const application = await app(driver);
      await application.container.make(Notifications).send(alan, OrderShipped, { orderId: 'o-2' });
      await application.queue!.work();
      expect(await rows(application)).toHaveLength(1);
      application.mail.assertNothingQueued();
    });

    it('sends to several recipients — an id each', async () => {
      const application = await app(driver);
      const ids = await application.container.make(Notifications).send([ada, grace], OrderShipped, { orderId: 'o-3' });
      expect(ids).toHaveLength(2);
      await application.queue!.work();
      expect((await rows(application)).map((row) => row.recipient_id).sort()).toEqual(['1', '3']);
      application.mail.assertQueuedCount(ShippedMail, 2);
      application.mail.assertQueued(ShippedMail, (mail, message) => mail.member.id === 3 && message.subject === 'Shipped: o-3');
    });

    it('keeps only what static database describes — a field toDatabase() adds anyway is not stored', async () => {
      // (A type error where it is sent — the runtime keeps to static database all the same.)
      class Leaky {
        static readonly notification = 'shop.leaky';
        static readonly schema = OrderShipped.schema;
        static readonly database = OrderShipped.database;
        via() {
          return ['database'] as const;
        }
        toDatabase(data: { orderId: string }) {
          return { orderId: data.orderId, secret: 'nope' };
        }
      }
      const application = await app(driver, { notifications: [Leaky] });
      await application.container.make(Notifications).sendNow(ada, Leaky as never, { orderId: 'o-4' } as never);
      expect((await rows(application))[0]!.data).toEqual({ orderId: 'o-4' });
    });

    it('fails a job whose data no longer matches the schema after a deploy at once — no retries that cannot succeed', async () => {
      const application = await app(driver);
      const queue = application.container.make(Queue);
      await queue.dispatch(SendQueuedNotification as never, { id: crypto.randomUUID(), notification: 'shop.order-shipped', recipient: { type: 'member', id: 1 }, data: { order: 7 } } as never);
      const result = await application.queue!.work();
      expect(result).toMatchObject({ processed: 1, failed: 1, released: 0 });
      const [failed] = await application.queue!.failed();
      expect(failed!.exception).toContain('no longer matches its static schema');
      expect(await rows(application)).toEqual([]);
    });

    it('retries a job of a notification this worker does not know (renamed, or an older worker in a rolling deploy)', async () => {
      const application = await app(driver);
      await application.container.make(Queue).dispatch(SendQueuedNotification as never, { id: crypto.randomUUID(), notification: 'shop.renamed', recipient: ada, data: {} } as never);
      expect(await application.queue!.work()).toMatchObject({ failed: 0, released: 1 });
    });

    it('fails a delivery through a channel the app does not have, at once', async () => {
      const application = await app(driver, { notifications: [OrderShipped, Faxed as never] });
      await application.container.make(Notifications).send(ada, Faxed as never, {} as never);
      expect(await application.queue!.work()).toMatchObject({ failed: 1, released: 0 });
      expect((await application.queue!.failed())[0]!.exception).toContain('"fax"');
    });

    it('drops a notification whose recipient is gone (discarded, not failed)', async () => {
      const application = await app(driver);
      await application.container.make(Queue).dispatch(SendQueuedNotification as never, { id: crypto.randomUUID(), notification: 'shop.welcome', recipient: { type: 'member', id: 99 }, data: { code: 'x' } } as never);
      expect(await application.queue!.work()).toMatchObject({ processed: 1, failed: 0 });
      expect(await rows(application)).toEqual([]);
    });

    it('delivers a notification once, also when its job runs twice (at-least-once): the row says it went through', async () => {
      const application = await app(driver);
      const deliverer = application.container.make(NotificationDeliverer);
      const pending = { id: crypto.randomUUID(), notification: OrderShipped, recipient: ada, data: { orderId: 'o-5' } };
      expect(await deliverer.deliver(application.container.createScope(), pending)).toBe('delivered');
      expect(await deliverer.deliver(application.container.createScope(), pending)).toBe('delivered-before');
      expect(await rows(application)).toHaveLength(1);
      application.mail.assertQueuedCount(ShippedMail, 1);
    });

    it('is queued with the transaction around it — gone after a rollback', async () => {
      const application = await app(driver, { queue: 'database' });
      const connections = application.container.make(Connections);
      await expect(
        connections.transaction(async () => {
          await application.container.make(Notifications).send(ada, Welcome, { code: 'rolled-back' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const { rows: jobs } = await sql<{ id: number }>`select id from jobs`.execute(connections.get());
      expect(jobs).toEqual([]);
    });

    it('keeps the data out of the jobs table in plain text (encrypted)', async () => {
      const application = await app(driver, { queue: 'database' });
      await application.container.make(Notifications).send(ada, OrderShipped, { orderId: 'o-plain-text-7', carrier: 'secret-carrier' });
      const { rows: jobs } = await sql<{ payload: string }>`select payload from jobs`.execute(application.connections.get());
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).not.toContain('o-plain-text-7');
      expect(jobs[0]!.payload).not.toContain('secret-carrier');
    });
  });

  describe('sendNow', () => {
    it('delivers in this process — the row is there when it resolves, the mail is queued (mailer.queue)', async () => {
      const application = await app(driver);
      const id = await application.container.make(Notifications).sendNow(ada, OrderShipped, { orderId: 'o-6' });
      expect((await rows(application))[0]).toMatchObject({ id, data: { orderId: 'o-6' } });
      application.queue!.assertNotDispatched(SendQueuedNotification);
      application.mail.assertQueued(ShippedMail, (_mail, message) => message.subject === 'Versandt: o-6');
    });

    it('is part of the transaction around it: a rollback leaves no row', async () => {
      const application = await app(driver);
      await expect(
        application.connections.transaction(async () => {
          await application.container.make(Notifications).sendNow(alan, OrderShipped, { orderId: 'o-7' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await rows(application)).toEqual([]);
    });
  });

  describe('checked when sent', () => {
    it('refuses data its schema rejects, a kind of recipient nobody finds, and an unregistered notification', async () => {
      const application = await app(driver, { notifications: [OrderShipped] });
      const notifications = application.container.make(Notifications);
      await expect(notifications.send(ada, OrderShipped, { orderId: 7 } as never)).rejects.toThrow(/OrderShipped \(shop.order-shipped\) cannot be sent: its static schema rejects the data: orderId: /);
      await expect(notifications.send({ type: 'team', id: 'core' }, OrderShipped as never, { orderId: 'x' } as never)).rejects.toThrow(/sent to a "team" recipient, but no module finds those/);
      await expect(notifications.send(ada, Welcome, { code: 'x' })).rejects.toThrow(/Welcome is not a registered notification — list it in its module: notifications: \[Welcome\]/);
      application.queue!.assertNothingDispatched();
    });

    it('fails the start for a notification without a name, a name used twice, two resolvers of one kind', async () => {
      const start = (modules: Parameters<typeof createApplication>[0]['modules']) =>
        createApplication({ root: '/tmp', discover: false, providers: [DatabaseServiceProvider, NotificationServiceProvider], modules }, { env: { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY }, override: (c) => c.instance(Logger, silent) });
      class Nameless {
        static readonly schema = OrderShipped.schema;
        via() {
          return [];
        }
      }
      class Twin extends Welcome {}
      await expect(start([{ name: 'a', notifications: [Nameless as never] }])).rejects.toThrow(NotificationSetupError);
      await expect(start([{ name: 'a', notifications: [Nameless as never] }])).rejects.toThrow('[marmeon:Q6] ');
      await expect(start([{ name: 'a', notifications: [Nameless as never] }])).rejects.toThrow(/Nameless \(module a\) needs a stable name: static notification = 'module.what-happened'/);
      await expect(start([{ name: 'a', notifications: [Welcome, Twin] }])).rejects.toThrow(/Two notifications are named "shop.welcome": Welcome \(module a\) and Twin \(module a\)/);
      class OtherMembers extends Members {}
      await expect(start([{ name: 'a', recipients: { member: Members } }, { name: 'b', recipients: { member: OtherMembers } }])).rejects.toThrow(/Two resolvers find "member" recipients: Members \(module a\) and OtherMembers \(module b\)/);
    });
  });

  describe('the inbox — always bound to its recipient', () => {
    async function seeded() {
      const application = await app(driver);
      const notifications = application.container.make(Notifications);
      const adas = [await notifications.sendNow(ada, Welcome, { code: 'a1' }), await notifications.sendNow(ada, Welcome, { code: 'a2' })];
      application.clock.travel({ seconds: 1 });
      const alans = await notifications.sendNow(alan, Welcome, { code: 'b1' });
      return { application, inbox: application.container.make(Inbox), adas, alans };
    }

    it('counts, lists and marks only the recipient\'s own notifications', async () => {
      const { inbox, adas, alans } = await seeded();
      expect(await inbox.count(ada)).toBe(2);
      expect(await inbox.count(alan)).toBe(1);
      expect((await inbox.unread(ada)).map((row) => row.id).sort()).toEqual([...adas].sort());
      expect((await inbox.latest(alan)).map((row) => row.id)).toEqual([alans]);
      expect(await inbox.markRead(ada, adas[0]!)).toBe(true);
      expect(await inbox.count(ada)).toBe(1);
      expect((await inbox.latest(ada)).find((row) => row.id === adas[0])!.readAt).not.toBeNull();
    });

    it('does not mark someone else\'s notification read — false (the controller answers 404), nothing changed (IDOR)', async () => {
      const { application, inbox, alans } = await seeded();
      expect(await inbox.markRead(ada, alans)).toBe(false);
      expect(await inbox.count(alan)).toBe(1);
      expect((await rows(application)).find((row) => row.id === alans)!.read_at).toBeNull();
    });

    it('marks all of one recipient\'s notifications read — nobody else\'s', async () => {
      const { inbox } = await seeded();
      expect(await inbox.markAllRead(ada)).toBe(2);
      expect(await inbox.count(ada)).toBe(0);
      expect(await inbox.count(alan)).toBe(1);
      expect(await inbox.markAllRead(ada)).toBe(0);
    });

    it('deletes only the recipient\'s own notification — someone else\'s is false (404), nothing changed (IDOR)', async () => {
      const { application, inbox, adas, alans } = await seeded();
      expect(await inbox.delete(ada, alans)).toBe(false);
      expect((await rows(application)).map((row) => row.id)).toContain(alans);
      expect(await inbox.delete(ada, adas[0]!)).toBe(true);
      expect(await inbox.delete(ada, adas[0]!)).toBe(false);
      expect((await inbox.latest(ada)).map((row) => row.id)).toEqual([adas[1]]);
      for (const id of ['1', 'not-a-uuid', "' or 1=1 --", '']) expect(await inbox.delete(ada, id)).toBe(false);
    });

    it('pages through the recipient\'s own notifications, newest first — by an encrypted cursor', async () => {
      const { application, inbox, adas } = await seeded();
      const notifications = application.container.make(Notifications);
      application.clock.travel({ seconds: 1 });
      const newest = await notifications.sendNow(ada, Welcome, { code: 'a3' });
      const encrypter = application.container.make(Encrypter);
      const first = await inbox.page(ada, { perPage: 2, encrypter });
      expect(first.data.map((row) => row.id)[0]).toBe(newest);
      expect(first.data).toHaveLength(2);
      const second = await inbox.page(ada, { perPage: 2, cursor: first.meta.nextCursor, encrypter });
      expect([...first.data, ...second.data].map((row) => row.id).sort()).toEqual([...adas, newest].sort());
      expect(second.meta.nextCursor).toBeNull();
      // Alan's list is his own; a cursor of Ada's list is no way into it — not even a position: it does not decrypt for his.
      expect((await inbox.page(alan, { encrypter })).data).toHaveLength(1);
      await expect(inbox.page(alan, { perPage: 2, cursor: first.meta.nextCursor, encrypter })).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it("deletes all of a recipient's notifications at once — a deleted account's — and nobody else's", async () => {
      const { inbox, adas } = await seeded();
      expect(await inbox.deleteAll(ada)).toBe(adas.length);
      expect(await inbox.latest(ada)).toEqual([]);
      expect(await inbox.latest(alan)).toHaveLength(1);
      expect(await inbox.deleteAll(ada)).toBe(0);
    });

    it('takes an id that is no notification\'s for none (no database error on Postgres\'s uuid column)', async () => {
      const { inbox } = await seeded();
      for (const id of ['1', 'not-a-uuid', "' or 1=1 --", '']) expect(await inbox.markRead(ada, id)).toBe(false);
    });

    it('keeps a read notification read with its first time', async () => {
      const { application, inbox, adas } = await seeded();
      await inbox.markRead(ada, adas[0]!);
      const first = (await inbox.latest(ada)).find((row) => row.id === adas[0])!.readAt;
      application.clock.travel({ minutes: 5 });
      expect(await inbox.markRead(ada, adas[0]!)).toBe(true);
      expect((await inbox.latest(ada)).find((row) => row.id === adas[0])!.readAt).toBe(first);
    });

    it('reads a row back typed — and a row a deploy changed as nothing', async () => {
      const { application, inbox, adas } = await seeded();
      const [newest] = await inbox.latest(ada);
      expect(notificationData(newest!, Welcome)).toMatchObject({ code: expect.stringMatching(/^a[12]$/) });
      expect(notificationData(newest!, OrderShipped)).toBeUndefined();
      await sql`update notifications set data = ${JSON.stringify({ other: 1 })} where id = ${adas[0]!}`.execute(application.connections.get());
      const changed = (await inbox.latest(ada)).find((row) => row.id === adas[0])!;
      expect(notificationData(changed, Welcome)).toBeUndefined();
    });
  });

  describe('notifications:prune', () => {
    it('deletes read notifications older than --days, keeps recent and unread ones — unread too only with --unread-days', async () => {
      const application = await app(driver);
      const notifications = application.container.make(Notifications);
      const inbox = application.container.make(Inbox);
      const oldRead = await notifications.sendNow(ada, Welcome, { code: 'old-read' });
      const oldUnread = await notifications.sendNow(ada, Welcome, { code: 'old-unread' });
      const lateRead = await notifications.sendNow(ada, Welcome, { code: 'old, read late' });
      await inbox.markRead(ada, oldRead);
      application.clock.travel({ days: 20 });
      const recentRead = await notifications.sendNow(ada, Welcome, { code: 'recent-read' });
      await inbox.markRead(ada, recentRead);
      await inbox.markRead(ada, lateRead); // came 40 days before the prune, read 20 days before it: stays
      application.clock.travel({ days: 20 });
      const unread = await notifications.sendNow(alan, Welcome, { code: 'unread' });

      const command = new PruneNotificationsCommand(application.container.make(NotificationStore), application.clock);
      const first = output();
      expect(await command.handle({ args: [], options: { days: '30' }, output: first.output } as never)).toBe(0);
      expect(first.lines).toEqual(['Pruned 1 notification.']);
      expect((await rows(application)).map((row) => row.id).sort()).toEqual([oldUnread, lateRead, recentRead, unread].sort());

      const second = output();
      expect(await command.handle({ args: [], options: { days: '30', 'unread-days': '30' }, output: second.output } as never)).toBe(0);
      expect((await rows(application)).map((row) => row.id).sort()).toEqual([lateRead, recentRead, unread].sort());
      expect(await command.handle({ args: [], options: { days: 'x' }, output: output().output } as never)).toBe(1);
    });
  });
});

describe('NotificationFake', () => {
  it('records sends after checking them as for real — and delivers them on demand', async () => {
    const application = await app('sqlite');
    const fake = new NotificationFake(application.container);
    application.container.instance(Notifications, fake);
    const notifications = application.container.make(Notifications);
    await notifications.send(ada, OrderShipped, { orderId: 'o-8' });
    await notifications.sendNow(alan, Welcome, { code: 'w' });
    fake.assertSent(ada, OrderShipped).assertSent(ada, OrderShipped, { orderId: 'o-8' }).assertSentTimes(ada, OrderShipped, 1);
    fake.assertNotSent(alan, OrderShipped).assertNotSent(ada, OrderShipped, { orderId: 'other' });
    expect(fake.sent(Welcome, alan)[0]).toMatchObject({ now: true, data: { code: 'w' } });
    expect(() => fake.assertSent(grace, OrderShipped)).toThrow(/Expected OrderShipped to be sent to member 3\. Sent: OrderShipped to member 1; Welcome to member 2\./);
    expect(() => fake.assertNothingSent()).toThrow();
    await expect(notifications.send(ada, OrderShipped, { orderId: 1 } as never)).rejects.toThrow(/static schema rejects/);
    expect(await rows(application)).toEqual([]);

    expect((await fake.deliver()).map((entry) => entry.outcome)).toEqual(['delivered', 'delivered']);
    expect(await rows(application)).toHaveLength(2);
    expect(await fake.deliver()).toEqual([]);
  });

  it('records a send inside a transaction with its commit — nothing after a rollback', async () => {
    const application = await app('sqlite');
    const fake = new NotificationFake(application.container);
    await expect(
      application.connections.transaction(async () => {
        await fake.send(ada, Welcome, { code: 'x' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    fake.assertNothingSent();
  });
});

describe('without a queue in the app', () => {
  it('says what send() needs (sendNow does not need it)', async () => {
    const application = await createApplication({
      root: '/tmp',
      discover: false,
      providers: [DatabaseServiceProvider, NotificationServiceProvider],
      modules: [{ name: 'shop', notifications: [Welcome], recipients: { member: Members } }],
    }, { env: { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, override: (c) => c.instance(Logger, silent) });
    try {
      await expect(application.container.make(Notifications).send(ada, Welcome, { code: 'x' })).rejects.toThrow(/needs @marmeon\/queue/);
    } finally {
      await application.shutdown();
    }
  });
});

describe('the payload of marmeon.notification as the queue keeps it', () => {
  it('reads every fixture of the format', async () => {
    const directory = new URL('./__fixtures__/formats/queued-notification/', import.meta.url);
    const names = readdirSync(directory);
    expect(names).toContain('v1.json');
    for (const name of names) {
      const result = await SendQueuedNotification.schema['~standard'].validate(JSON.parse(readFileSync(new URL(name, directory), 'utf8')));
      expect(result.issues, name).toBeUndefined();
    }
  });
});
