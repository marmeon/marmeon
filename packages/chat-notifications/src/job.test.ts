import type { Logger } from '@marmeon/core';
import { HttpClientFake } from '@marmeon/fetch/testing';
import type { JobContext } from '@marmeon/queue';
import { describe, expect, it } from 'vitest';
import type { ChatDriverFactory } from './driver.ts';
import { SendQueuedChatMessage, queuedChatSchema, type QueuedChatPayload } from './job.ts';
import { ChatDeliveryError, ChatError } from './errors.ts';
import { normalizeMessage } from './message.ts';
import { ChatPoster } from './poster.ts';
import { ChatTargets } from './targets.ts';

const slackSecret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slackUrl = ['https://hooks.slack.com/services', slackSecret].join('/');
const discordUrl = ['https://discord.com/api/webhooks', '1234567890', 'd'.repeat(40)].join('/');

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function setup(driver = 'slack', webhooks: Record<string, string> = { ops: slackUrl }, custom: Record<string, ChatDriverFactory> = {}) {
  const http = new HttpClientFake();
  const targets = new ChatTargets({ driver, webhooks: new Map(Object.entries(webhooks)), custom: () => new Map(Object.entries(custom)), context: (name) => ({ name, container: undefined as never, logger: silent }) });
  const poster = new ChatPoster({ targets, http: () => http, logger: silent, clock: { now: () => 0 }, protected: false });
  return { http, job: new SendQueuedChatMessage(poster, targets) };
}

interface Calls {
  released: unknown[];
  failed: unknown[];
  signals: AbortSignal[];
}

function context(): JobContext & { calls: Calls } {
  const calls: Calls = { released: [], failed: [], signals: [] };
  const controller = new AbortController();
  return {
    calls,
    id: 'job-1',
    name: 'marmeon.chat',
    attempt: 1,
    tries: 5,
    queue: 'default',
    connection: 'sync',
    signal: controller.signal,
    discard: () => undefined,
    release: (delay) => void calls.released.push(delay),
    fail: (reason) => void calls.failed.push(reason),
    once: async () => true,
  };
}

const content = (text = 'Deploy done'): QueuedChatPayload['content'] => ({ text, fields: [], links: [] });
const reply = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body === '' ? null : body, { status, headers });

describe('SendQueuedChatMessage', () => {
  it('is the encrypted framework job marmeon.chat with its own retries', () => {
    const { job, encrypted, tries, backoff, timeout } = SendQueuedChatMessage;
    expect({ job, encrypted, tries, backoff, timeout }).toEqual({ job: 'marmeon.chat', encrypted: true, tries: 5, backoff: [10, 60, 300], timeout: 30 });
  });

  it('posts a named destination and finishes', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200, 'ok'));
    const run = context();
    await job.handle({ to: { name: 'ops' }, content: content() }, run);
    http.assertSentCount(1);
    expect(run.calls).toMatchObject({ released: [], failed: [] });
  });

  it('posts a recipient address with the driver that formats for it', async () => {
    const { http, job } = setup('slack', {});
    http.respond(/./, reply(204));
    await job.handle({ to: { url: discordUrl, driver: 'discord' }, content: content() }, context());
    expect(await http.requests[0]?.clone().json()).toMatchObject({ embeds: expect.any(Array) });
  });

  it('releases the job for the seconds the webhook asks for when it throttles, and for a 503 that names them', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(429, 'rate_limited', { 'retry-after': '7' }));
    const run = context();
    await job.handle({ to: { name: 'ops' }, content: content() }, run);
    expect(run.calls).toEqual({ released: [7], failed: [], signals: [] });
    http.respond(/./, reply(503, '', { 'retry-after': '12' }));
    await job.handle({ to: { name: 'ops' }, content: content() }, run);
    expect(run.calls.released).toEqual([7, 12]);
  });

  it('rethrows what a retry may fix, so the backoff applies: a throttle without seconds, a 5xx, a network failure', async () => {
    for (const respond of [(http: HttpClientFake) => http.respond(/./, reply(429)), (http: HttpClientFake) => http.respond(/./, reply(502)), (http: HttpClientFake) => http.respond(/./, reply(200)).failNext('network')]) {
      const { http, job } = setup();
      respond(http);
      const run = context();
      const error = await job.handle({ to: { name: 'ops' }, content: content() }, run).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChatDeliveryError);
      expect(run.calls).toMatchObject({ released: [], failed: [] });
    }
  });

  it('fails the job at once when the webhook is gone, rejects the message, or refuses the request', async () => {
    for (const [respond, reason] of [
      [(http: HttpClientFake) => http.respond(/./, reply(404, 'no_service')), 'gone'],
      [(http: HttpClientFake) => http.respond(/./, reply(410)), 'gone'],
      [(http: HttpClientFake) => http.respond(/./, reply(400, 'invalid_payload')), 'rejected'],
      [(http: HttpClientFake) => http.respond(/./, reply(200)).failNext('refused'), 'refused'],
    ] as const) {
      const { http, job } = setup();
      respond(http);
      const run = context();
      await job.handle({ to: { name: 'ops' }, content: content() }, run);
      expect(run.calls.failed, reason).toHaveLength(1);
      expect(run.calls.failed[0], reason).toMatchObject({ reason });
      expect(run.calls.released).toEqual([]);
    }
  });

  it('checks the address again at the accepting side: a crafted payload for another host is failed as refused, and no request is sent', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200));
    for (const to of [
      { url: `https://chat.example.com/services/${slackSecret}` },
      { url: `https://hooks.slack.com.evil.example/services/${slackSecret}`, driver: 'slack' },
      { url: `http://hooks.slack.com/services/${slackSecret}` },
      { url: `https://169.254.169.254/services/${slackSecret}` },
      { url: `https://hooks.slack.com/services/${slackSecret}`, driver: 'discord' },
    ]) {
      const run = context();
      await job.handle({ to, content: content() }, run);
      expect(run.calls.failed, JSON.stringify(to)).toHaveLength(1);
      expect(run.calls.failed[0], JSON.stringify(to)).toMatchObject({ reason: 'refused' });
    }
    http.assertNothingSent();
  });

  it('checks the address of a custom driver in the worker: a host it does not list is a permanent failure and no request is sent', async () => {
    const mattermost: ChatDriverFactory = () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (content) => ({ json: { text: content.text } }) });
    const { http, job } = setup('slack', { ops: slackUrl }, { mattermost });
    http.respond(/./, reply(200));
    const run = context();
    await job.handle({ to: { url: 'https://evil.example/hooks/abc', driver: 'mattermost' }, content: content() }, run);
    await job.handle({ to: { url: 'https://chat.example.com/other/abc', driver: 'mattermost' }, content: content() }, run);
    expect(run.calls.failed).toHaveLength(2);
    for (const failed of run.calls.failed) expect(failed).toMatchObject({ reason: 'refused', permanent: true });
    http.assertNothingSent();
    await job.handle({ to: { url: 'https://chat.example.com/hooks/abc', driver: 'mattermost' }, content: content() }, run);
    http.assertSentCount(1);
  });

  it('fails permanently, with no request, for a driver whose lists or request cannot be read', async () => {
    const broken: ChatDriverFactory = () => ({
      get hosts(): string[] {
        throw new Error('boom');
      },
      paths: ['/hooks/'],
      render: () => ({ json: {} }),
    });
    const throwingJson: ChatDriverFactory = () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: () => ({ get json(): never { throw new Error(`boom ${slackUrl}`); } }) });
    const { http, job } = setup('slack', { ops: slackUrl }, { broken, throwingjson: throwingJson });
    http.respond(/./, reply(200));
    const run = context();
    await job.handle({ to: { url: 'https://chat.example.com/hooks/abc', driver: 'broken' }, content: content() }, run);
    await job.handle({ to: { url: 'https://chat.example.com/hooks/abc', driver: 'throwingjson' }, content: content() }, run);
    expect(run.calls.failed.map((failed) => (failed as Error).message)).toEqual([
      'The chat driver "broken" must return a ChatDriver: reading it failed.',
      'The chat driver "throwingjson" returned a request that could not be read.',
    ]);
    for (const failed of run.calls.failed) expect(failed).toBeInstanceOf(ChatError);
    expect(run.calls.released).toEqual([]);
    http.assertNothingSent();
  });

  it('fails a payload whose named destination this worker lacks, and one whose driver it lacks', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200));
    const run = context();
    await job.handle({ to: { name: 'alerts' }, content: content() }, run);
    await job.handle({ to: { url: slackUrl, driver: 'mattermost' }, content: content() }, run);
    expect(run.calls.failed).toHaveLength(2);
    for (const failed of run.calls.failed) expect(failed).toBeInstanceOf(ChatError);
    expect(run.calls.failed.map((failed) => (failed as Error).message)).toEqual([
      'No destination "alerts" — CHAT_WEBHOOKS names ops.',
      'The chat driver "mattermost" is not known. Known: slack, discord, teams.',
    ]);
    http.assertNothingSent();
  });

  it('normalizes the content again: a crafted payload with an empty text, a bad raw format or a name that is not a name is failed, and nothing is sent', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200));
    const payloads = [
      { to: { name: 'ops' }, content: content('   ') },
      { to: { name: 'ops' }, content: { ...content(), raw: { slack: { blocks: 'x' } } } },
      { to: { name: 'OPS' }, content: content() },
      { to: { name: 'ops' }, content: { ...content(), raw: { slack: { n: Number.NaN } } } },
      { to: { url: 'not an address' }, content: content() },
    ] as unknown as QueuedChatPayload[];
    for (const payload of payloads) {
      const run = context();
      await job.handle(payload, run);
      expect(run.calls.failed, JSON.stringify(payload)).toHaveLength(1);
    }
    http.assertNothingSent();
  });

  it('checks the raw keys again in the worker: a key that names no driver of this worker is failed and nothing is sent', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200));
    const run = context();
    await job.handle({ to: { name: 'ops' }, content: { ...content(), raw: { teems: {} } } }, run);
    expect(run.calls.failed).toHaveLength(1);
    expect(run.calls.failed[0]).toBeInstanceOf(ChatError);
    expect((run.calls.failed[0] as Error).message).toBe('Chat message: "raw.teems" names no chat driver. Known: slack, discord, teams.');
    http.assertNothingSent();
  });

  it('passes the signal of the job to the request', async () => {
    const { http, job } = setup();
    http.respond(/./, reply(200));
    const run = context();
    const controller = new AbortController();
    controller.abort();
    const aborted: JobContext = { ...run, signal: controller.signal };
    const error = await job.handle({ to: { name: 'ops' }, content: content() }, aborted).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'unavailable' });
  });
});

describe('queuedChatSchema', () => {
  const validate = async (value: unknown) => queuedChatSchema['~standard'].validate(value);

  it('accepts what the notifier queues, JSON in raw included', async () => {
    const { content: normalized } = normalizeMessage({ to: { url: slackUrl, driver: 'slack' }, text: 'x', raw: { slack: { blocks: [{ type: 'divider', n: [1, null, true, 'a', { b: 2 }] }] } } });
    const payload = { to: { url: slackUrl, driver: 'slack' }, content: JSON.parse(JSON.stringify(normalized)) as unknown };
    const result = await validate(payload);
    if (result.issues) throw new Error('expected the payload to be valid');
    expect(result.value).toEqual(payload);
  });

  it('refuses a destination with both a name and an address, an unknown key in it, and a payload without content', async () => {
    for (const payload of [
      { to: { name: 'ops', url: slackUrl }, content: content() },
      { to: { name: 'ops', driver: 'slack' }, content: content() },
      { to: { url: slackUrl, extra: 1 }, content: content() },
      { to: 'ops', content: content() },
      { to: { name: 'ops' } },
      { to: { name: 'ops' }, content: { ...content(), fields: 'x' } },
    ]) {
      expect((await validate(payload)).issues, JSON.stringify(payload)).toBeDefined();
    }
  });
});
