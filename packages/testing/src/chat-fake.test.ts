import { defineModule, type ApplicationDefinition, type StandardSchemaV1 } from '@marmeon/core';
import { ChatNotifier, ChatServiceProvider } from '@marmeon/chat-notifications';
import { ChatFake } from '@marmeon/chat-notifications/testing';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { FetchServiceProvider } from '@marmeon/fetch';
import { NotificationServiceProvider, type NotificationData } from '@marmeon/notifications';
import { QueueServiceProvider } from '@marmeon/queue';
import { describe, expect, it } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { importChat } from './import-chat.ts';
import { createTestApp } from './index.ts';

// A made-up address of the shape the Slack guard accepts: nothing is posted, so none is real (and none looks like a token).
const opsUrl = 'https://hooks.slack.com/services/test-ops';

declare module '@marmeon/notifications' {
  interface NotificationRecipients {
    operator: { readonly id: number; readonly locale: string };
  }
}

class Operators {
  async find(id: number) {
    return { id, locale: 'en' };
  }

  locale(operator: { readonly locale: string }): string {
    return operator.locale;
  }
}

/** The data of `Paged`, as a schema of its own: this package has no schema library. */
const pagedSchema: StandardSchemaV1<{ service: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => (typeof value === 'object' && value !== null && typeof (value as { service?: unknown }).service === 'string' ? { value: value as { service: string } } : { issues: [{ message: 'service must be a string' }] }),
  },
};

/** A notification that goes to the chat channel only. */
class Paged {
  static readonly notification = 'ops.paged';
  static readonly schema = pagedSchema;

  via() {
    return ['chat'] as const;
  }

  toChat(_operator: unknown, data: NotificationData<typeof Paged>) {
    return { to: 'ops', title: 'Paged', text: `${data.service} is down` };
  }
}

/** A notification whose message names a destination `CHAT_WEBHOOKS` does not list. */
class Lost {
  static readonly notification = 'ops.lost';
  static readonly schema = pagedSchema;

  via() {
    return ['chat'] as const;
  }

  toChat() {
    return { to: 'nowhere', text: 'lost' };
  }
}

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-chat-'),
  discover: false,
  providers: [DatabaseServiceProvider, FetchServiceProvider, EncryptionServiceProvider, QueueServiceProvider, NotificationServiceProvider, ChatServiceProvider],
  modules: [defineModule({ name: 'chat-fake', notifications: [Paged, Lost], recipients: { operator: Operators } })],
};

// Notifications need the database services; a chat-only notification writes no row, so an empty in-memory database serves.
// CHAT_DRIVER and CHAT_WEBHOOKS are the values docs/fakes.md and docs/chat-notifications.md show for a test.
const env = { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: generateKey(), CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${opsUrl}`, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' };

describe('app.chat', () => {
  it('is the ChatNotifier of the container, a fake that records', async () => {
    await using app = await createTestApp(definition, { env });
    expect(app.chat).toBeInstanceOf(ChatFake);
    expect(app.make(ChatNotifier)).toBe(app.chat);
    await app.chat.send({ to: 'ops', text: 'hello' });
    app.chat.assertSent({ to: 'ops' }).assertSentCount(1);
  });

  it("is not bound with chat: 'real': the container keeps the real notifier and app.chat says why", async () => {
    await using app = await createTestApp(definition, { env, chat: 'real' });
    // the real notifier is not exported; the next test proves by behaviour that it posts through app.http
    expect(app.make(ChatNotifier)).not.toBeInstanceOf(ChatFake);
    expect(() => app.chat).toThrow("app.chat needs @marmeon/chat-notifications in the app (and not createTestApp(…, { chat: 'real' })).");
  });

  it('posts through the app.http fake and runs the queued job with app.queue.work() under chat: real', async () => {
    await using app = await createTestApp(definition, { env, chat: 'real' });
    app.http.respond(/./, new Response('ok'));
    const real = app.make(ChatNotifier);
    await real.send({ to: 'ops', text: 'sent now' });
    await real.queue({ to: 'ops', title: 'Queued', text: 'queued for the worker' });
    app.http.assertSentCount(1);
    await app.queue.work();
    app.http.assertSentCount(2);
    expect(app.http.requests.map((request) => request.url)).toEqual([opsUrl, opsUrl]);
    expect(await app.http.requests[0]!.clone().text()).toContain('sent now');
    expect(await app.http.requests[1]!.clone().text()).toContain('queued for the worker');
  });

  it('is absent from an app without the provider, which still starts', async () => {
    await using app = await createTestApp({ root: tempDir('marmeon-testing-chat-none-'), discover: false, modules: [defineModule({ name: 'no-chat' })] });
    expect(app.container.has(ChatNotifier)).toBe(false);
    expect(() => app.chat).toThrow('app.chat needs @marmeon/chat-notifications');
  });

  it('queues through the queue services of the app, like the real notifier, and dispatches no job', async () => {
    await using app = await createTestApp(definition, { env });
    await app.chat.queue({ to: 'ops', text: 'queued' }, { delay: 5 });
    app.chat.assertQueued({ to: 'ops', text: 'queued' }).assertQueuedCount(1);
    expect(app.chat.queued[0]!.options).toEqual({ delay: 5 });
    app.queue.assertNothingDispatched();
  });

  it('refuses queue() in an app without the queue services, as the real notifier does', async () => {
    const noQueue: ApplicationDefinition = { ...definition, providers: [FetchServiceProvider, ChatServiceProvider] };
    await using app = await createTestApp(noQueue, { env });
    await expect(app.chat.queue({ to: 'ops', text: 'queued' })).rejects.toThrow('chat.queue() needs @marmeon/queue');
  });

  it('records the chat message of a notification that app.notifications.deliver() delivers, and requests nothing', async () => {
    await using app = await createTestApp(definition, { env });
    await app.notifications.send({ type: 'operator', id: 1 }, Paged, { service: 'api' });
    app.chat.assertQueuedCount(0);
    await app.notifications.deliver();
    app.chat.assertQueued({ to: 'ops', title: 'Paged', text: 'api is down' }).assertQueuedCount(1);
    app.http.assertNothingSent();
    app.queue.assertNothingDispatched();
  });

  it('fails the delivery of a notification whose message names a destination CHAT_WEBHOOKS does not list', async () => {
    await using app = await createTestApp(definition, { env });
    await app.notifications.send({ type: 'operator', id: 1 }, Lost, { service: 'api' });
    await expect(app.notifications.deliver()).rejects.toThrow('No destination "nowhere" — CHAT_WEBHOOKS names ops.');
    app.chat.assertNothingQueued();
  });
});

describe('app.chat with the database of a test', () => {
  const refreshDefinition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-chat-db-'),
    discover: false,
    providers: [EncryptionServiceProvider, FetchServiceProvider, QueueServiceProvider, DatabaseServiceProvider, NotificationServiceProvider, ChatServiceProvider],
    modules: [defineModule({ name: 'chat-refresh', migrations: new URL('./__fixtures__/migrations/', import.meta.url), notifications: [Paged], recipients: { operator: Operators } })],
  };
  const refreshEnv = { APP_KEY: generateKey(), CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${opsUrl}`, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' };

  it('records a message queued in the transaction of the test, and a delivered notification', async () => {
    await using app = await createTestApp(refreshDefinition, { env: refreshEnv, database: 'refresh' });
    await app.chat.queue({ to: 'ops', text: 'in the test transaction' });
    app.chat.assertQueued({ text: 'in the test transaction' });
    await app.notifications.send({ type: 'operator', id: 1 }, Paged, { service: 'api' });
    await app.notifications.deliver();
    app.chat.assertQueuedCount(2);
  });

  it('records a message queued in a transaction when it commits, with inTransaction, and never after a rollback', async () => {
    await using app = await createTestApp(refreshDefinition, { env: refreshEnv, database: 'refresh' });
    const connections = app.make(Connections);
    await connections
      .transaction(async () => {
        await app.chat.queue({ to: 'ops', text: 'rolled back' });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    app.chat.assertNothingQueued();
    await connections.transaction(async () => {
      await app.chat.queue({ to: 'ops', text: 'committed' });
    });
    app.chat.assertQueued({ text: 'committed' }).assertQueuedCount(1);
    expect(app.chat.queued[0]!.inTransaction).toBe(true);
  });
});

describe('importChat', () => {
  const notFound = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });

  it('loads both entries of the package', async () => {
    const modules = await importChat();
    expect(modules?.ChatNotifier).toBe(ChatNotifier);
    expect(modules?.ChatFake).toBe(ChatFake);
  });

  it.each([
    ["Cannot find package '@marmeon/chat-notifications' imported from /app/node_modules/@marmeon/testing/dist/test-app.js"],
    ["Cannot find module '@marmeon/chat-notifications/testing' imported from /app/dist/import-chat.js"],
  ])('is undefined when the package itself is not installed: %s', async (message) => {
    await expect(importChat(() => Promise.reject(notFound(message)))).resolves.toBeUndefined();
  });

  it.each([
    ['a package it needs is missing', notFound("Cannot find package '@marmeon/fetch' imported from /app/node_modules/@marmeon/chat-notifications/dist/index.js")],
    ['only the importer is the package', notFound("Cannot find package 'valibot' imported from /app/node_modules/@marmeon/chat-notifications/dist/index.js")],
    ['the code does not parse', new SyntaxError('Unexpected token')],
    ['another error carries the code', Object.assign(new Error("Cannot find package '@marmeon/chat-notifications'"), { code: 'ERR_OTHER' })],
  ])('throws the error when %s, so a test never runs against the real notifier by accident', async (_name, error) => {
    await expect(importChat(() => Promise.reject(error))).rejects.toBe(error);
  });
});
