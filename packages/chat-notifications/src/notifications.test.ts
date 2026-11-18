import { readdirSync } from 'node:fs';
import { createApplication, Logger, type Application, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import {
  NotificationChannelError,
  NotificationChannels,
  NotificationError,
  NotificationServiceProvider,
  Notifications,
  SendQueuedNotification,
  type NotificationData,
  type RecipientResolver,
} from '@marmeon/notifications';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QUEUE_MIGRATION } from '@marmeon/queue/internal';
import { QueueFake } from '@marmeon/queue/testing';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDriverFactory } from './driver.ts';
import { ChatDriverError, ChatError } from './errors.ts';
import { ChatNotifier } from './notifier.ts';
import type { ChatMessage } from './message.ts';
import { SendQueuedChatMessage } from './job.ts';
import { ChatServiceProvider, importNotifications } from './provider.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
// webhook addresses are joined at run time
const slackSecret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slackUrl = ['https://hooks.slack.com/services', slackSecret].join('/');
const ownSecret = ['own', 'hook', 'c'.repeat(20)].join('/');
const ownSlackUrl = ['https://hooks.slack.com/services', ownSecret].join('/');
const otherUrl = 'https://chat.example.com/hooks/' + 'k'.repeat(20);

declare module '@marmeon/notifications' {
  interface NotificationRecipients {
    member: Member;
  }
  interface NotificationChannelMap {
    /** A channel the tests register: it only throws. */
    boom: {};
  }
}

interface Member {
  readonly id: number;
  readonly name: string;
  readonly locale: string;
  /** The address the member entered for their own chat alerts. */
  readonly chatUrl: string | undefined;
}

const MEMBERS = new Map<number, Member>([
  [1, { id: 1, name: 'Ada', locale: 'de', chatUrl: undefined }],
  [2, { id: 2, name: 'Alan', locale: 'en', chatUrl: otherUrl }],
  [3, { id: 3, name: 'Grace', locale: 'en', chatUrl: ownSlackUrl }],
]);

class Members implements RecipientResolver<'member'> {
  async find(id: number): Promise<Member | undefined> {
    return MEMBERS.get(id);
  }

  locale(member: Member): string {
    return member.locale;
  }
}

const ada = { type: 'member', id: 1 } as const;
const alan = { type: 'member', id: 2 } as const;
const grace = { type: 'member', id: 3 } as const;

/** A row, and a chat message: to the member's own address when they entered one, else to `ops`. */
class Alerted {
  static readonly notification = 'shop.alerted';
  static readonly schema = v.object({ order: v.string() });
  static readonly database = v.object({ order: v.string() });
  static readonly queue = { queue: 'alerts', tries: 2, backoff: 5 };

  via() {
    return ['database', 'chat'] as const;
  }

  toDatabase(data: NotificationData<typeof Alerted>) {
    return { order: data.order };
  }

  toChat(member: Member, data: NotificationData<typeof Alerted>, t: { readonly locale: string }): ChatMessage {
    return { to: member.chatUrl === undefined ? 'ops' : { url: member.chatUrl }, title: `Alert for ${member.name}`, text: `${t.locale}: order ${data.order}` };
  }
}

/** Goes through the chat channel and has no `toChat`. */
class Mute {
  static readonly notification = 'shop.mute';
  static readonly schema = v.object({});

  via() {
    return ['chat'] as const;
  }
}

/** The chat message is queued, then a later channel throws: the whole delivery rolls back. */
class Doomed {
  static readonly notification = 'shop.doomed';
  static readonly schema = v.object({});
  static readonly database = v.object({});

  via() {
    return ['database', 'chat', 'boom'] as const;
  }

  toDatabase() {
    return {};
  }

  toChat(): ChatMessage {
    return { to: 'ops', text: 'never queued' };
  }
}

/** To a destination `CHAT_WEBHOOKS` does not list. */
class Lost {
  static readonly notification = 'shop.lost';
  static readonly schema = v.object({});
  static readonly database = v.object({});

  via() {
    return ['database', 'chat'] as const;
  }

  toDatabase() {
    return {};
  }

  toChat(): ChatMessage {
    return { to: 'nowhere', text: 'lost' };
  }
}

/** A message with no text. */
class Blank {
  static readonly notification = 'shop.blank';
  static readonly schema = v.object({});

  via() {
    return ['chat'] as const;
  }

  toChat(): ChatMessage {
    return { to: 'ops', text: '' };
  }
}

/** Composes its message asynchronously. */
class Later {
  static readonly notification = 'shop.later';
  static readonly schema = v.object({});

  via() {
    return ['chat'] as const;
  }

  async toChat(): Promise<ChatMessage> {
    await Promise.resolve();
    return { to: 'ops', text: 'composed later' };
  }
}

/** To an address the recipient entered, as it was entered. */
class Entered {
  static readonly notification = 'shop.entered';
  static readonly schema = v.object({ url: v.string(), driver: v.optional(v.string()), text: v.optional(v.string()), raw: v.optional(v.object({ slack: v.object({ blocks: v.string() }) })) });
  static readonly database = v.object({});

  via() {
    return ['database', 'chat'] as const;
  }

  toDatabase() {
    return {};
  }

  toChat(_member: Member, data: NotificationData<typeof Entered>): ChatMessage {
    return { to: data.driver === undefined ? { url: data.url } : { url: data.url, driver: data.driver }, text: data.text ?? 'entered', ...(data.raw === undefined ? {} : { raw: data.raw as never }) };
  }
}

/** For a custom driver whose factory throws. */
class Odd {
  static readonly notification = 'shop.odd';
  static readonly schema = v.object({});
  static readonly queue = { tries: 3, backoff: 5 };

  via() {
    return ['chat'] as const;
  }

  toChat(): ChatMessage {
    return { to: { url: 'https://odd.example.com/hooks/abc', driver: 'odd' }, text: 'odd' };
  }
}

interface Env {
  driver: string;
  webhooks?: string;
  providers?: ServiceProviderClass[];
}

interface Warning {
  message: string;
  context: unknown;
}

interface Harness {
  app: Application;
  warnings: Warning[];
  http: HttpClientFake;
  queue: QueueFake;
  connections: Connections;
}

const open: Application[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.shutdown();
});

function recording(warnings: Warning[]): Logger {
  const logger: Logger = { debug() {}, info() {}, warn: (message: string, context: unknown) => void warnings.push({ message, context }), error() {}, child: () => logger } as unknown as Logger;
  return logger;
}

/** An app with notifications, the chat channel, a faked queue and HTTP client, and an in-memory database with the two tables. */
async function harness({ driver, webhooks = `ops=${slackUrl}`, providers = [] }: Env): Promise<Harness> {
  const http = new HttpClientFake();
  const warnings: Warning[] = [];
  let queue!: QueueFake;
  const app = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider, FetchServiceProvider, NotificationServiceProvider, ChatServiceProvider, ...providers],
      modules: [{ name: 'shop', notifications: [Alerted, Mute, Doomed, Lost, Blank, Later, Odd, Entered], recipients: { member: Members } }],
    },
    {
      env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test', LOG_LEVEL: 'silent', CHAT_DRIVER: driver, CHAT_WEBHOOKS: webhooks },
      override: (container) => {
        container.instance(Logger, recording(warnings));
        container.instance(HttpClient, http);
        queue = new QueueFake(container);
        container.instance(Queue, queue);
      },
    },
  );
  open.push(app);
  const connections = app.container.make(Connections);
  const directory = NotificationServiceProvider.migrations.from;
  const files = readdirSync(directory).map((name) => new URL(name, `${directory.href}/`));
  for (const file of [...files, QUEUE_MIGRATION]) await runMigration(connections, ((await import(file.href)) as { default: Migration }).default);
  return { app, warnings, http, queue, connections };
}

async function rowCount(connections: Connections): Promise<number> {
  const { rows } = await sql<{ id: string }>`select id from notifications`.execute(connections.get());
  return rows.length;
}

describe('the chat channel', { timeout: 30_000 }, () => {
  it('queues the message with the delivery, on the notification\'s queue, and makes no request while the delivery runs', async () => {
    const { app, http, queue, connections } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).sendNow(ada, Alerted, { order: 'o-1' });
    expect(await rowCount(connections)).toBe(1);
    queue.assertDispatched(SendQueuedChatMessage, { to: { name: 'ops' }, content: { title: 'Alert for Ada', text: 'de: order o-1', fields: [], links: [] } });
    const [job] = queue.dispatched(SendQueuedChatMessage);
    expect(job).toMatchObject({ queue: 'alerts', inTransaction: true });
    http.assertNothingSent();
  });

  it('composes the message in the recipient\'s language: `t` is the translator of the resolver\'s locale()', async () => {
    const { app, queue } = await harness({ driver: 'slack' });
    const notifications = app.container.make(Notifications);
    await notifications.sendNow(ada, Alerted, { order: 'o-2' });
    await notifications.sendNow(grace, Alerted, { order: 'o-2' });
    expect(queue.dispatched(SendQueuedChatMessage).map((job) => job.payload.content.text)).toEqual(['de: order o-2', 'en: order o-2']);
  });

  it('queues a recipient\'s own address in the encrypted job and posts it in the worker with the driver of CHAT_DRIVER', async () => {
    const { app, http, queue } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).sendNow(grace, Alerted, { order: 'o-3' });
    expect(queue.dispatched(SendQueuedChatMessage)[0]?.payload.to).toEqual({ url: ownSlackUrl });
    expect(SendQueuedChatMessage.encrypted).toBe(true);
    http.respond(/./, new Response('ok', { status: 200 }));
    const result = await queue.work();
    expect(result).toMatchObject({ failed: 0, released: 0 });
    http.assertSentCount(1);
    expect(http.requests[0]?.url).toBe(ownSlackUrl);
  });

  it('retries a webhook that is down in the chat job alone: the row stays, no second notification job exists', async () => {
    const { app, http, queue, connections } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).sendNow(ada, Alerted, { order: 'o-4' });
    http.respond(/./, new Response('', { status: 503 }));
    const result = await queue.work();
    http.assertSentCount(1);
    expect(result).toMatchObject({ failed: 0, released: 1 });
    expect(await queue.failed()).toEqual([]);
    expect(await rowCount(connections)).toBe(1);
    queue.assertNotDispatched(SendQueuedNotification);
    expect(queue.dispatched(SendQueuedChatMessage)).toHaveLength(1);
  });

  it('leaves no marmeon.chat job when a later channel of the same delivery throws', async () => {
    const { app, queue, connections } = await harness({ driver: 'slack' });
    app.container.make(NotificationChannels).add('boom', () => ({
      async deliver() {
        throw new Error('the next channel is down');
      },
    }));
    await expect(app.container.make(Notifications).sendNow(ada, Doomed, {})).rejects.toThrow('the next channel is down');
    queue.assertNotDispatched(SendQueuedChatMessage);
    expect(await rowCount(connections)).toBe(0);
  });

  it('skips a recipient\'s refused address with a warning that names the host only: the row is written, no chat job, no request', async () => {
    const { app, http, queue, connections, warnings } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).sendNow(alan, Alerted, { order: 'o-5' });
    expect(await rowCount(connections)).toBe(1);
    queue.assertNotDispatched(SendQueuedChatMessage);
    http.assertNothingSent();
    expect(warnings).toEqual([{ message: 'Alerted (shop.alerted): the chat message was not queued, a webhook on chat.example.com is refused.', context: { notification: 'shop.alerted' } }]);
    expect(JSON.stringify(warnings)).not.toContain('hooks');
    expect(JSON.stringify(warnings)).not.toContain('k'.repeat(20));
  });

  it('skips the same address when it was entered under another CHAT_DRIVER: the notification job still succeeds', async () => {
    const { app, queue, connections, warnings } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).send(alan, Alerted, { order: 'o-6' });
    const result = await queue.work();
    expect(result).toMatchObject({ failed: 0, released: 0 });
    expect(await rowCount(connections)).toBe(1);
    expect(warnings).toHaveLength(1);
    queue.assertNotDispatched(SendQueuedChatMessage);
  });

  it('fails the delivery at once for a destination CHAT_WEBHOOKS lacks, with the exact message, and writes no row', async () => {
    const { app, queue, connections } = await harness({ driver: 'slack' });
    const error = await app.container.make(Notifications).sendNow(ada, Lost, {}).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationChannelError);
    expect((error as Error).message).toBe('Lost (shop.lost): The chat message to destination "nowhere" is refused: No destination "nowhere" — CHAT_WEBHOOKS names ops.');
    expect((error as Error).cause).toBeInstanceOf(ChatError);
    expect(((error as Error).cause as Error).message).toBe('The chat message to destination "nowhere" is refused: No destination "nowhere" — CHAT_WEBHOOKS names ops.');
    expect(await rowCount(connections)).toBe(0);
    await app.container.make(Notifications).send(ada, Lost, {});
    expect(await queue.work()).toMatchObject({ failed: 1, released: 0 });
  });

  it('fails the delivery at once for a named destination whose address the sink refuses: that is configuration, not a recipient\'s entry', async () => {
    const { app, warnings } = await harness({ driver: 'log', webhooks: 'ops=http://chat.example.com/hooks/abc' });
    const error = await app.container.make(Notifications).sendNow(ada, Alerted, { order: 'o-10' }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationChannelError);
    expect((error as Error).message).toBe('Alerted (shop.alerted): The chat message to destination "ops" is refused: The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
    expect(warnings).toEqual([]);
  });

  it('fails the delivery at once for a message with no text', async () => {
    const { app } = await harness({ driver: 'slack' });
    const error = await app.container.make(Notifications).sendNow(ada, Blank, {}).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationChannelError);
    expect((error as Error).message).toBe('Blank (shop.blank): Chat message: "text" must not be empty.');
  });

  it('rethrows what a retry may fix: a driver whose factory throws releases the notification job, it is not failed at once', async () => {
    const odd: ChatDriverFactory = () => {
      throw new Error('the factory is broken');
    };
    const provider = ({ OddProvider: class { static chatDrivers = { odd }; } }).OddProvider;
    const { app, queue } = await harness({ driver: 'slack', providers: [provider] });
    const error = await app.container.make(Notifications).sendNow(ada, Odd, {}).then(() => undefined, (caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(NotificationChannelError);
    expect(error).toBeInstanceOf(ChatDriverError);
    expect((error as Error).message).toBe('The chat message to a webhook on odd.example.com is refused: The chat driver "odd" could not be built.');
    await app.container.make(Notifications).send(ada, Odd, {});
    expect(await queue.work()).toMatchObject({ failed: 0, released: 1 });
  });

  it('retries whatever a driver threw, `undefined` included: from the factory and from render', async () => {
    const factory: ChatDriverFactory = () => {
      throw undefined;
    };
    const rendering: ChatDriverFactory = () => ({
      hosts: ['odd.example.com'],
      paths: ['/hooks/'],
      render: () => {
        throw undefined;
      },
    });
    for (const odd of [factory, rendering]) {
      const provider = ({ OddProvider: class { static chatDrivers = { odd }; } }).OddProvider;
      const { app, queue } = await harness({ driver: 'slack', providers: [provider] });
      const error = await app.container.make(Notifications).sendNow(ada, Odd, {}).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChatDriverError);
      expect(error).not.toBeInstanceOf(NotificationChannelError);
      await app.container.make(Notifications).send(ada, Odd, {});
      expect(await queue.work()).toMatchObject({ failed: 0, released: 1 });
    }
  });

  it('recovers in the same app: a factory that throws on the first attempt and works on the second queues the message on the retry', async () => {
    let calls = 0;
    const odd: ChatDriverFactory = () => {
      calls += 1;
      if (calls === 1) throw new Error('not yet');
      return { hosts: ['odd.example.com'], paths: ['/hooks/'], render: (content) => ({ json: { text: content.text } }) };
    };
    const provider = ({ OddProvider: class { static chatDrivers = { odd }; } }).OddProvider;
    const { app, queue } = await harness({ driver: 'slack', providers: [provider] });
    await expect(app.container.make(Notifications).sendNow(ada, Odd, {})).rejects.toBeInstanceOf(ChatDriverError);
    queue.assertNotDispatched(SendQueuedChatMessage);
    await app.container.make(Notifications).sendNow(ada, Odd, {});
    queue.assertDispatched(SendQueuedChatMessage, { to: { url: 'https://odd.example.com/hooks/abc', driver: 'odd' } });
  });

  it('skips an address that is empty or too long like any refused address of a recipient: row written, no chat job, a warning with the host at most', async () => {
    const tooLong = `https://chat.example.com/hooks/${'k'.repeat(2000)}`;
    for (const [url, text] of [
      ['', 'a webhook address that is not a URL'],
      [tooLong, 'a webhook on chat.example.com'],
    ] as const) {
      const { app, queue, connections, warnings } = await harness({ driver: 'slack' });
      await app.container.make(Notifications).sendNow(ada, Entered, { url });
      expect(await rowCount(connections)).toBe(1);
      queue.assertNotDispatched(SendQueuedChatMessage);
      expect(warnings).toEqual([{ message: `Entered (shop.entered): the chat message was not queued, ${text} is refused.`, context: { notification: 'shop.entered' } }]);
      expect(JSON.stringify(warnings)).not.toContain('kkkk');
    }
  });

  it('does not let an empty address hide a mistake of the code: an unknown driver or an empty text fails the delivery at once, a valid message is skipped', async () => {
    const { app, queue, connections, warnings } = await harness({ driver: 'slack' });
    const notifications = app.container.make(Notifications);
    const fails = async (data: { url: string; driver?: string; text?: string; raw?: { slack: { blocks: string } } }) => notifications.sendNow(ada, Entered, data).then(() => undefined, (caught: unknown) => caught as Error);
    const unknownDriver = await fails({ url: '', driver: 'missing', text: 'fine' });
    expect(unknownDriver).toBeInstanceOf(NotificationChannelError);
    expect(unknownDriver?.message).toBe('Entered (shop.entered): The chat message to a webhook address that is not a URL is refused: The chat driver "missing" is not known. Known: slack, discord, teams.');
    const emptyText = await fails({ url: '', text: '' });
    expect(emptyText).toBeInstanceOf(NotificationChannelError);
    expect(emptyText?.message).toBe('Entered (shop.entered): Chat message: "text" must not be empty.');
    const badRaw = await fails({ url: '', raw: { slack: { blocks: 'not a list' } } });
    expect(badRaw).toBeInstanceOf(NotificationChannelError);
    expect(badRaw?.message).toBe('Entered (shop.entered): Chat message: "raw.slack.blocks" must be a list.');
    const both = await fails({ url: '', driver: 'missing', text: '' });
    expect(both).toBeInstanceOf(NotificationChannelError);
    expect(await rowCount(connections)).toBe(0);
    expect(warnings).toEqual([]);
    await notifications.sendNow(ada, Entered, { url: '', text: 'fine' });
    expect(await rowCount(connections)).toBe(1);
    expect(warnings).toHaveLength(1);
    queue.assertNotDispatched(SendQueuedChatMessage);
  });

  it('rethrows an error that is no ChatError unchanged: a queue that is down is not a NotificationChannelError', async () => {
    const { app } = await harness({ driver: 'slack' });
    const down = new Error('the queue is down');
    const scope = app.container.createScope();
    scope.instance(ChatNotifier, { send: async () => undefined, queue: async () => Promise.reject(down), check: () => undefined });
    await expect(scope.make(Notifications).sendNow(ada, Alerted, { order: 'o-8' })).rejects.toBe(down);
  });

  it('builds the notifier in the delivery\'s scope: an override there is the one that is used', async () => {
    const { app, queue } = await harness({ driver: 'slack' });
    const seen: ChatMessage[] = [];
    const scope = app.container.createScope();
    scope.instance(ChatNotifier, { send: async () => undefined, queue: async (message) => void seen.push(message), check: () => undefined });
    await scope.make(Notifications).sendNow(ada, Alerted, { order: 'o-9' });
    expect(seen).toEqual([{ to: 'ops', title: 'Alert for Ada', text: 'de: order o-9' }]);
    queue.assertNotDispatched(SendQueuedChatMessage);
  });

  it('awaits an async toChat before it queues', async () => {
    const { app, queue } = await harness({ driver: 'slack' });
    await app.container.make(Notifications).sendNow(ada, Later, {});
    queue.assertDispatched(SendQueuedChatMessage, { to: { name: 'ops' }, content: { text: 'composed later', fields: [], links: [] } });
  });

  it('refuses in the worker an address that CHAT_DRIVER=log accepted: a driver switch does not turn the sink\'s address into a request', async () => {
    const sink = await harness({ driver: 'log' });
    await sink.app.container.make(Notifications).sendNow(alan, Alerted, { order: 'o-7' });
    const [queued] = sink.queue.dispatched(SendQueuedChatMessage);
    expect(queued?.payload.to).toEqual({ url: otherUrl });
    // the same message, picked up by a worker that runs under slack
    const worker = await harness({ driver: 'slack' });
    // `JobInput` of a payload that holds `ChatJson` is too deep for the compiler; the schema checks the payload at the dispatch
    await worker.queue.dispatch(SendQueuedChatMessage as never, queued!.payload as never);
    worker.http.respond(/./, new Response('ok', { status: 200 }));
    const result = await worker.queue.work();
    expect(result).toMatchObject({ failed: 1, released: 0 });
    expect((await worker.queue.failed())[0]?.exception).toContain('refused');
    worker.http.assertNothingSent();
    sink.http.assertNothingSent();
  });

  it('says what is missing when the notification has no toChat', async () => {
    const { app } = await harness({ driver: 'slack' });
    // @ts-expect-error — the types refuse it too; the check is for a notification that got past them
    const error = await app.container.make(Notifications).sendNow(ada, Mute, {}).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationError);
    expect(error).not.toBeInstanceOf(NotificationChannelError);
    expect((error as Error).message).toBe('Mute (shop.mute) goes through the chat channel, but has no toChat(recipient, data, t) method.');
  });
});

describe('without @marmeon/notifications', () => {
  const error = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

  it('registers nothing when the app has no notifications, and the channel is added once an app does', async () => {
    const without = await createApplication({ root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, ChatServiceProvider] }, { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } });
    open.push(without);
    expect(without.container.has(NotificationChannels)).toBe(false);
    const { app } = await harness({ driver: 'log' });
    expect(app.container.make(NotificationChannels).has('chat')).toBe(true);
  });

  it('imports it as an optional peer: undefined only when the package itself is missing', async () => {
    expect(await importNotifications(() => Promise.reject(error("Cannot find package '@marmeon/notifications' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
    await expect(importNotifications(() => Promise.reject(error('boom while loading')))).rejects.toThrow('boom while loading');
    await expect(importNotifications(() => Promise.reject(error("Cannot find package '@marmeon/notifications' imported from x")))).rejects.toThrow('Cannot find package');
    await expect(importNotifications(() => Promise.reject(error("Cannot find package '@marmeon/notificationsX' imported from x", 'ERR_MODULE_NOT_FOUND')))).rejects.toThrow('notificationsX');
    await expect(importNotifications(() => Promise.reject(error("Cannot find package 'something-else' imported from /app/node_modules/@marmeon/notifications/dist/index.js", 'ERR_MODULE_NOT_FOUND')))).rejects.toThrow('something-else');
  });
});
