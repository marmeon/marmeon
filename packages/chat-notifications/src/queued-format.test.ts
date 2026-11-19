import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, type Logger } from '@marmeon/core';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import type { JobContext } from '@marmeon/queue';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QueueFake } from '@marmeon/queue/testing';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { SendQueuedChatMessage, type QueuedChatPayload } from './job.ts';
import { ChatNotifier } from './notifier.ts';
import { ChatPoster } from './poster.ts';
import { ChatServiceProvider } from './provider.ts';
import { ChatTargets } from './targets.ts';

// The fixtures are the decrypted payload of the job `marmeon.chat` (the envelope around it is the queue's format). Their addresses are
// made up and no token: they only have the shape the guard of their driver accepts.
const DIRECTORY = new URL('./__fixtures__/formats/queued-chat/', import.meta.url);
const OPS = 'https://hooks.slack.com/services/test';
const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const fixture = (name: string): QueuedChatPayload => JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8')) as QueuedChatPayload;
const validate = (value: unknown) => SendQueuedChatMessage.schema['~standard'].validate(value) as Promise<{ value?: QueuedChatPayload; issues?: readonly { message: string; path?: readonly unknown[] }[] }>;

function worker() {
  const http = new HttpClientFake();
  const targets = new ChatTargets({ driver: 'slack', webhooks: new Map([['ops', OPS]]), custom: () => new Map(), context: (name) => ({ name, container: undefined as never, logger: silent }) });
  const poster = new ChatPoster({ targets, http: () => http, logger: silent, clock: { now: () => 0 }, protected: false });
  return { http, job: new SendQueuedChatMessage(poster, targets) };
}

const run = (): JobContext & { failed: unknown[]; released: unknown[] } => {
  const failed: unknown[] = [];
  const released: unknown[] = [];
  return {
    failed,
    released,
    id: 'job-1',
    name: 'marmeon.chat',
    attempt: 1,
    tries: 5,
    queue: 'default',
    connection: 'sync',
    signal: new AbortController().signal,
    discard: () => undefined,
    release: (delay) => void released.push(delay),
    fail: (reason) => void failed.push(reason),
    once: async () => true,
  };
};

describe('the payload of marmeon.chat as the queue keeps it', () => {
  it('has a fixture of every version and shape of the destination', () => {
    expect(readdirSync(DIRECTORY).sort()).toEqual(['v1-raw.json', 'v1-url.json', 'v1.json']);
  });

  it('reads every fixture of the format, unchanged', async () => {
    for (const name of readdirSync(DIRECTORY)) {
      const result = await validate(fixture(name));
      expect(result.issues, name).toBeUndefined();
      // `v.object` drops the keys it does not know: nothing may be dropped
      expect(result.value, name).toEqual(fixture(name));
    }
  });

  it('hands every fixture to the worker, which posts it to the host of its destination', async () => {
    const hosts: Record<string, string> = { 'v1.json': 'hooks.slack.com', 'v1-raw.json': 'hooks.slack.com', 'v1-url.json': 'discord.com' };
    for (const name of readdirSync(DIRECTORY)) {
      const { http, job } = worker();
      http.respond(/./, new Response(null, { status: 204 }));
      const context = run();
      await job.handle(fixture(name), context);
      expect(context.failed, name).toEqual([]);
      http.assertSentCount(1);
      expect(new URL(http.requests[0]!.url).host, name).toBe(hosts[name]);
    }
  });

  it('posts the body its fixture describes', async () => {
    const { http, job } = worker();
    http.respond(/./, new Response('ok'));
    await job.handle(fixture('v1.json'), run());
    const body = JSON.stringify(await http.requests[0]!.clone().json());
    for (const text of ['Deploy done', 'Version 1.4.2 is live.', 'eu-west', 'Release notes']) expect(body).toContain(text);
    const raw = worker();
    raw.http.respond(/./, new Response('ok'));
    await raw.job.handle(fixture('v1-raw.json'), run());
    expect(await raw.http.requests[0]!.clone().json()).toMatchObject({ blocks: [{ type: 'section', text: { text: '*Deploy* done' } }] });
  });

  it('is what chat.queue() writes today', async () => {
    const queue: { fake?: QueueFake } = {};
    const app = await createApplication(
      { root: workspaceTempDir('marmeon-chat-format-'), discover: false, providers: [FetchServiceProvider, EncryptionServiceProvider, QueueServiceProvider, ChatServiceProvider] },
      {
        env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', APP_KEY: KEY, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${OPS}` },
        override: (container) => {
          container.instance(HttpClient, new HttpClientFake());
          queue.fake = new QueueFake(container);
          container.instance(Queue, queue.fake);
        },
      },
    );
    try {
      const chat = app.container.make(ChatNotifier);
      await chat.queue({ to: 'ops', title: 'Deploy done', text: 'Version 1.4.2 is live.', fields: [{ label: 'Region', value: 'eu-west' }], links: [{ label: 'Release notes', url: 'https://example.com/releases/1.4.2' }] });
      await chat.queue({ to: { url: 'https://discord.com/api/webhooks/1/test', driver: 'discord' }, title: 'Payment failed', text: 'Order o-1 was declined.', fields: [{ label: 'Order', value: 'o-1' }], links: [{ label: 'Open the order', url: 'https://example.com/orders/o-1' }] });
      await chat.queue({ to: 'ops', text: 'Deploy done', raw: { slack: { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Deploy* done' } }] } } });
      const payloads = queue.fake!.dispatched(SendQueuedChatMessage).map((job) => job.payload);
      expect(payloads).toEqual([fixture('v1.json'), fixture('v1-url.json'), fixture('v1-raw.json')]);
    } finally {
      await app.shutdown();
    }
  });

  it('refuses a destination with a name and an address, or a key it does not know', async () => {
    const both = await validate({ ...fixture('v1.json'), to: { name: 'ops', url: OPS } });
    expect(both.issues?.length).toBeGreaterThan(0);
    expect(both.issues?.[0]?.path?.map((key) => (key as { key: unknown }).key)).toEqual(['to']);
    const unknown = await validate({ ...fixture('v1-url.json'), to: { url: OPS, driver: 'slack', extra: 1 } });
    expect(unknown.issues?.length).toBeGreaterThan(0);
  });

  it('refuses a content without text, and a raw format that is an array', async () => {
    const { text: _text, ...withoutText } = fixture('v1.json').content;
    const missing = await validate({ ...fixture('v1.json'), content: withoutText });
    expect(missing.issues?.map((issue) => issue.path?.map((key) => (key as { key: unknown }).key))).toEqual([['content', 'text']]);
    const array = await validate({ ...fixture('v1.json'), content: { ...fixture('v1.json').content, raw: [] } });
    expect(array.issues?.map((issue) => [issue.message, issue.path?.map((key) => (key as { key: unknown }).key)])).toEqual([['must be an object', ['content', 'raw']]]);
  });
});
