import { AssertionError } from 'node:assert';
import { createApplication, type Application, type ServiceProviderClass } from '@marmeon/core';
import { runTransaction } from '@marmeon/core/internal';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { QueueError, QueueServiceProvider } from '@marmeon/queue';
import { describe, expect, it } from 'vitest';
import { ChatDeliveryError, ChatError } from './errors.ts';
import { ChatNotifier } from './notifier.ts';
import { ChatFake, type ChatMatch } from './fake.ts';
import { ChatServiceProvider } from './provider.ts';
import * as testing from './testing.ts';

// webhook addresses are joined at run time
const slackSecret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slackUrl = ['https://hooks.slack.com/services', slackSecret].join('/');
const opsUrl = ['https://hooks.slack.com/services', 'T1', 'B1', 'o'.repeat(24)].join('/');

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

async function boot({ queue = true, extra = [] }: { queue?: boolean; extra?: ServiceProviderClass[] } = {}): Promise<{ app: Application; chat: ChatFake; real: ChatNotifier }> {
  const providers = [FetchServiceProvider, ...(queue ? [EncryptionServiceProvider, QueueServiceProvider] : []), ChatServiceProvider, ...extra] as ServiceProviderClass[];
  const app = await createApplication(
    { root: import.meta.dirname, discover: false, providers },
    {
      env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', APP_KEY: KEY, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${opsUrl}` },
      // the real notifier's sync queue posts for real: every request is answered by the fake client, none leaves the machine
      override: (container) => container.instance(HttpClient, new HttpClientFake().respond(/./, new Response('ok'))),
    },
  );
  return { app, chat: new ChatFake(app.container), real: app.container.make(ChatNotifier) };
}

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;
const failure = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the assertion to fail.');
};

describe('ChatFake: recording', () => {
  it('is exported from the testing entry', () => {
    expect(testing.ChatFake).toBe(ChatFake);
  });

  it('records send() and queue() apart', async () => {
    const { chat } = await boot();
    await chat.send({ to: 'ops', title: 'Now', text: 'sent' });
    await chat.queue({ to: 'ops', text: 'later' }, { queue: 'chat', delay: { minutes: 5 } });
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toMatchObject({ to: 'ops', queued: false, inTransaction: false, content: { title: 'Now', text: 'sent' } });
    expect(chat.sent[0]!.options).toEqual({});
    expect(chat.queued).toHaveLength(1);
    expect(chat.queued[0]).toMatchObject({ to: 'ops', queued: true, options: { queue: 'chat', delay: { minutes: 5 } }, inTransaction: false, content: { text: 'later' } });
  });

  it('records a queued message after the commit, not before', async () => {
    const { chat } = await boot();
    await runTransaction({}, 'test', async () => {
      await chat.queue({ to: 'ops', text: 'after the commit' });
      expect(chat.queued).toHaveLength(0);
    });
    expect(chat.queued).toHaveLength(1);
    expect(chat.queued[0]!.inTransaction).toBe(true);
  });

  it('never records a queued message of a rolled back transaction', async () => {
    const { chat } = await boot();
    await rejection(
      runTransaction({}, 'test', async () => {
        await chat.queue({ to: 'ops', text: 'undone' });
        throw new Error('rollback');
      }),
    );
    chat.assertNothingQueued();
  });

  it('refuses an unknown named destination', async () => {
    const { chat } = await boot();
    const error = await rejection(chat.send({ to: 'nowhere', text: 'x' }));
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toContain('nowhere');
    expect(await rejection(chat.queue({ to: 'nowhere', text: 'x' }))).toBeInstanceOf(ChatError);
    chat.assertNothingSent().assertNothingQueued();
  });

  it('refuses a { url } the driver does not accept, without naming the address', async () => {
    const { chat } = await boot();
    const bad = 'https://evil.example/services/T0/B0/secret-token';
    const sent = await rejection(chat.send({ to: { url: bad }, text: 'x' }));
    expect(sent).toBeInstanceOf(ChatDeliveryError);
    expect((sent as ChatDeliveryError).reason).toBe('refused');
    expect(sent.message).not.toContain('secret-token');
    const queued = await rejection(chat.queue({ to: { url: bad }, text: 'x' }));
    expect(queued).toBeInstanceOf(ChatError);
    expect(queued.message).not.toContain('secret-token');
    expect(chat.check({ url: bad })).toBeTypeOf('string');
    expect(chat.check({ url: slackUrl })).toBeUndefined();
    expect(chat.check('ops')).toBeUndefined();
    expect(chat.check('nowhere')).toBeTypeOf('string');
    chat.assertNothingSent().assertNothingQueued();
  });

  it('records the normalized, truncated text', async () => {
    const { chat } = await boot();
    await chat.send({ to: 'ops', text: 'a'.repeat(5000) });
    const { text } = chat.sent[0]!.content;
    expect([...text]).toHaveLength(2000);
    expect(text.endsWith('…')).toBe(true);
  });

  it('refuses a message that is mistaken, as the real notifier does', async () => {
    const { chat } = await boot();
    expect(await rejection(chat.send({ to: 'ops', text: '' }))).toBeInstanceOf(ChatError);
    expect(await rejection(chat.queue({ to: 'ops', text: 'x', raw: { nodriver: { a: 1 } } } as never))).toBeInstanceOf(ChatError);
  });

  it('fails the next sends with failNext(), then succeeds, and leaves queue() alone', async () => {
    const { chat } = await boot();
    const boom = new Error('boom');
    chat.failNext(boom, 2);
    expect(await rejection(chat.send({ to: 'ops', text: 'one' }))).toBe(boom);
    chat.assertNothingSent();
    await chat.queue({ to: 'ops', text: 'queued is not failed' });
    expect(await rejection(chat.send({ to: 'ops', text: 'two' }))).toBe(boom);
    await chat.send({ to: 'ops', text: 'three' });
    chat.assertSentCount(1).assertSent({ text: 'three' }).assertQueuedCount(1);
  });

  it('fails with a ChatDeliveryError (unavailable) by default', async () => {
    const { chat } = await boot();
    const error = await rejection(chat.failNext().send({ to: 'ops', text: 'x' }));
    expect(error).toBeInstanceOf(ChatDeliveryError);
    expect((error as ChatDeliveryError).reason).toBe('unavailable');
    expect(error.message).toBe('The fake chat notifier failed this send.');
  });
});

describe('ChatFake: assertions', () => {
  it('assertSent passes for a match and fails with the destination, never the address', async () => {
    const { chat } = await boot();
    const token = 'z'.repeat(24);
    const url = ['https://hooks.slack.com/services', 'T9', 'B9', token].join('/');
    await chat.send({ to: 'ops', title: 'Disk', text: 'full' });
    await chat.send({ to: { url }, title: 'Mine', text: 'mine' });
    expect(chat.assertSent()).toBe(chat);
    chat.assertSent({ to: 'ops' }).assertSent({ title: 'Disk', text: 'full' }).assertSent({ to: { url } }).assertSent((message) => message.content.text === 'mine');
    expect(failure(() => chat.assertSent({ to: 'ops', title: 'Other' })).message).toBe(
      'Expected a chat message to destination "ops" titled "Other" to be sent. Sent: destination "ops" titled "Disk"; a webhook on hooks.slack.com titled "Mine".',
    );
    const message = failure(() => chat.assertSent({ to: { url: ['https://hooks.slack.com/services', 'T8', 'B8', token].join('/') } })).message;
    expect(message).toContain('to a webhook on hooks.slack.com');
    expect(message).not.toContain(token);
    expect(message).not.toContain('https://');
    expect(failure(() => chat.assertSent(() => false)).message).toBe(
      'Expected a chat message matching the function to be sent. Sent: destination "ops" titled "Disk"; a webhook on hooks.slack.com titled "Mine".',
    );
  });

  it('assertSent fails when nothing was sent', async () => {
    const { chat } = await boot();
    expect(failure(() => chat.assertSent()).message).toBe('Expected a chat message to be sent. Sent: none.');
  });

  it('assertSentCount passes for the count and fails with the messages', async () => {
    const { chat } = await boot();
    await chat.send({ to: 'ops', text: 'a' });
    chat.assertSentCount(1);
    expect(failure(() => chat.assertSentCount(2)).message).toBe('Expected 2 chat messages to be sent, 1 was. Sent: destination "ops".');
  });

  it('assertNothingSent passes when nothing was sent and fails otherwise', async () => {
    const { chat } = await boot();
    chat.assertNothingSent();
    await chat.send({ to: 'ops', title: 'T', text: 'a' });
    expect(failure(() => chat.assertNothingSent()).message).toBe('Expected 0 chat messages to be sent, 1 was. Sent: destination "ops" titled "T".');
  });

  it('assertQueued passes for a match and fails with the destination, never the address', async () => {
    const { chat } = await boot();
    const token = 'y'.repeat(24);
    const url = ['https://hooks.slack.com/services', 'T9', 'B9', token].join('/');
    await chat.queue({ to: 'ops', text: 'later' });
    await chat.queue({ to: { url }, text: 'mine' });
    chat.assertQueued().assertQueued({ to: 'ops', text: 'later' }).assertQueued({ to: { url } });
    expect(failure(() => chat.assertQueued({ text: 'nope' })).message).toBe(
      'Expected a chat message with the text "nope" to be queued. Queued: destination "ops"; a webhook on hooks.slack.com.',
    );
    const message = failure(() => chat.assertQueued({ to: { url }, title: 'x' })).message;
    expect(message).not.toContain(token);
    expect(message).not.toContain('https://');
  });

  it('assertQueuedCount passes for the count and fails with the messages', async () => {
    const { chat } = await boot();
    await chat.queue({ to: 'ops', text: 'a' });
    chat.assertQueuedCount(1);
    expect(failure(() => chat.assertQueuedCount(0)).message).toBe('Expected 0 chat messages to be queued, 1 was. Queued: destination "ops".');
  });

  it('assertNothingQueued passes when nothing was queued and fails otherwise', async () => {
    const { chat } = await boot();
    chat.assertNothingQueued();
    await chat.queue({ to: 'ops', text: 'a' });
    expect(failure(() => chat.assertNothingQueued()).message).toBe('Expected 0 chat messages to be queued, 1 was. Queued: destination "ops".');
    chat.assertNothingSent();
  });
});

describe('ChatFake: parity with the real notifier', () => {
  it('send() reaches the raw check, and an unknown name is a ChatError, not a delivery error', async () => {
    const { chat, real } = await boot();
    const raw = await rejection(chat.send({ to: 'ops', text: 'x', raw: { nodriver: { a: 1 } } } as never));
    expect(raw).toBeInstanceOf(ChatError);
    expect(raw.message).toContain('names no chat driver');
    const refused = await rejection(chat.send({ to: 'ops', text: 'x', raw: { slack: 5 } } as never));
    expect(refused).toBeInstanceOf(ChatError);
    expect(refused.message).toBe((await rejection(real.send({ to: 'ops', text: 'x', raw: { slack: 5 } } as never))).message);
    const unknown = await rejection(chat.send({ to: 'nowhere', text: 'x' }));
    expect(unknown).toBeInstanceOf(ChatError);
    expect(unknown).not.toBeInstanceOf(ChatDeliveryError);
    expect(unknown.message).toBe((await rejection(real.send({ to: 'nowhere', text: 'x' }))).message);
    chat.assertNothingSent();
  });

  it('check() answers like the real notifier', async () => {
    const { chat, real } = await boot();
    for (const to of ['', { url: 'not a url' }, 'nowhere', 'ops', { url: slackUrl }, { url: 'https://evil.example/x' }] as never[]) {
      expect(chat.check(to)).toBe(real.check(to));
    }
    expect(chat.check('')).toBeTypeOf('string');
    expect(chat.check({ url: 'not a url' })).toBeTypeOf('string');
  });

  it('queue() refuses without the queue services, with the real notifier\'s message', async () => {
    const { chat, real } = await boot({ queue: false });
    const error = await rejection(chat.queue({ to: 'ops', text: 'x' }));
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toBe((await rejection(real.queue({ to: 'ops', text: 'x' }))).message);
    chat.assertNothingQueued();
  });

  it('queue() refuses a delay with the class and message of the real queue', async () => {
    const { chat, real } = await boot();
    const negative = await rejection(chat.queue({ to: 'ops', text: 'x' }, { delay: -1 }));
    expect(negative).toBeInstanceOf(QueueError);
    expect(negative.message).toBe('A delay must be seconds ≥ 0 (or a duration), not -1.');
    expect(negative.message).toBe((await rejection(real.queue({ to: 'ops', text: 'x' }, { delay: -1 }))).message);
    const negativeParts = await rejection(chat.queue({ to: 'ops', text: 'x' }, { delay: { minutes: -5 } }));
    expect(negativeParts).toBeInstanceOf(QueueError);
    expect(negativeParts.message).toBe('A delay must be seconds ≥ 0 (or a duration), not {"minutes":-5}.');
    for (const delay of ['5m', { foo: 1 }, Number.NaN, Number.POSITIVE_INFINITY] as never[]) {
      const error = await rejection(chat.queue({ to: 'ops', text: 'x' }, { delay }));
      const expected = await rejection(real.queue({ to: 'ops', text: 'x' }, { delay }));
      expect(error).toBeInstanceOf(TypeError);
      expect(expected).toBeInstanceOf(TypeError);
      expect(error.message).toBe(expected.message);
    }
    expect((await rejection(chat.queue({ to: 'ops', text: 'x' }, { delay: '5m' as never }))).message).toContain('{ minutes: 5 }');
    chat.assertNothingQueued();
    await chat.queue({ to: 'ops', text: 'x' }, { delay: 0 });
    await chat.queue({ to: 'ops', text: 'x' }, { delay: { seconds: 30 } });
    chat.assertQueuedCount(2);
  });

  it('keeps failNext() for the next good send: a refused send throws its own error first', async () => {
    const { chat } = await boot();
    const boom = new Error('boom');
    chat.failNext(boom);
    expect(await rejection(chat.send({ to: 'nowhere', text: 'x' }))).toBeInstanceOf(ChatError);
    const refused = await rejection(chat.send({ to: { url: 'https://evil.example/x' }, text: 'x' }));
    expect(refused).toBeInstanceOf(ChatDeliveryError);
    expect(refused).not.toBe(boom);
    expect(await rejection(chat.send({ to: 'ops', text: 'good' }))).toBe(boom);
    chat.assertNothingSent();
  });
});

describe('ChatFake: transactions', () => {
  it('records send() at once inside a transaction, and a queue() only after the commit, in call order', async () => {
    const { chat } = await boot();
    await runTransaction({}, 'test', async () => {
      await chat.queue({ to: 'ops', text: 'q1' });
      await chat.send({ to: 'ops', text: 's' });
      await chat.queue({ to: 'ops', text: 'q2' });
      await chat.queue({ to: 'ops', text: 'q3' });
      expect(chat.sent).toHaveLength(1);
      expect(chat.sent[0]!.inTransaction).toBe(true);
      expect(chat.queued).toHaveLength(0);
    });
    expect(chat.queued.map((message) => message.content.text)).toEqual(['q1', 'q2', 'q3']);
  });

  it('records send() as outside a transaction when the call chain started in one that has finished', async () => {
    const { chat } = await boot();
    let promise!: Promise<void>;
    await runTransaction({}, 'test', async () => {
      promise = new Promise<void>((resolve, reject) => setImmediate(() => chat.send({ to: 'ops', text: 'late' }).then(resolve, reject)));
    });
    await promise;
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]!.inTransaction).toBe(false);
  });
});

describe('ChatFake: matching', () => {
  const sendOne = async (): Promise<ChatFake> => {
    const { chat } = await boot();
    await chat.send({ to: 'ops', title: 'T', text: 'x' });
    await chat.send({ to: { url: slackUrl }, text: 'y' });
    return chat;
  };

  it('refuses a key it does not know, from a wide variable and from JavaScript, also when nothing was recorded', async () => {
    const chat = await sendOne();
    const wide: Record<string, unknown> = { fields: [] };
    expect(failure(() => chat.assertSent(wide as ChatMatch))).toBeInstanceOf(TypeError);
    expect(failure(() => chat.assertSent(wide as ChatMatch)).message).toContain('"fields"');
    expect(failure(() => chat.assertQueued({ txt: 'x' } as never))).toBeInstanceOf(TypeError);
    expect(failure(() => chat.assertSent('ops' as never))).toBeInstanceOf(TypeError);
  });

  it('never echoes a key that is not a name: an address used as a key leaves no part of its path in the error', async () => {
    const chat = await sendOne();
    const address = `${slackUrl}`;
    const error = failure(() => chat.assertSent({ [address]: 'x' } as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain('an unknown key');
    expect(error.message).not.toContain(slackSecret.slice(0, 6));
    expect(error.message).not.toContain('hooks.slack.com');
  });

  it('counts a function only when it returns true', async () => {
    const chat = await sendOne();
    expect(failure(() => chat.assertSent((async () => true) as never))).toBeInstanceOf(AssertionError);
    expect(failure(() => chat.assertSent((() => 1) as never))).toBeInstanceOf(AssertionError);
    chat.assertSent(() => true);
  });

  it('treats an undefined value as not given', async () => {
    const { chat } = await boot();
    await chat.send({ to: 'ops', title: 'A', text: 'x' });
    await chat.send({ to: 'ops', title: 'B', text: 'y' });
    chat.assertSent({ to: undefined, title: undefined, text: undefined }).assertSent({ title: undefined }).assertSent({ text: undefined }).assertSent({ to: undefined, text: 'x' });
    expect(failure(() => chat.assertQueued({ to: undefined, title: 'nope' })).message).toBe('Expected a chat message titled "nope" to be queued. Queued: none.');
  });

  it('compares a destination as normalized, and refuses one that is mistyped', async () => {
    const chat = await sendOne();
    chat.assertSent({ to: { url: slackUrl, driver: undefined } });
    const error = failure(() => chat.assertSent({ to: 'Ops' }));
    expect(error).toBeInstanceOf(ChatError);
  });
});

describe('ChatFake: isolation and arguments', () => {
  it('records frozen messages whose options a later change does not reach', async () => {
    const { chat } = await boot();
    const options = { queue: 'chat', delay: { minutes: 5 } };
    await chat.queue({ to: 'ops', text: 'x' }, options);
    options.queue = 'other';
    options.delay.minutes = 99;
    expect(chat.queued[0]!.options).toEqual({ queue: 'chat', delay: { minutes: 5 } });
    expect(Object.isFrozen(chat.queued[0])).toBe(true);
    expect(Object.isFrozen(chat.queued[0]!.options)).toBe(true);
  });

  it('records a Temporal.Duration delay by its parts and ignores an option it does not know', async () => {
    const { chat } = await boot();
    const delay = Temporal.Duration.from({ minutes: 5, seconds: 30 });
    await chat.queue({ to: 'ops', text: 'x' }, { delay, connection: 'redis', extra: () => 1 } as never);
    expect(chat.queued[0]!.options).toEqual({ connection: 'redis', delay: { days: 0, hours: 0, minutes: 5, seconds: 30, milliseconds: 0 } });
    expect(Object.isFrozen(chat.queued[0]!.options.delay)).toBe(true);
  });

  it('failNext() takes a positive whole number of times', async () => {
    const { chat } = await boot();
    for (const times of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0, 1.5]) {
      expect(failure(() => chat.failNext(undefined, times))).toBeInstanceOf(TypeError);
    }
    await chat.send({ to: 'ops', text: 'no failure was armed' });
    chat.assertSentCount(1);
  });
});

describe('ChatFake: the same checks in the same order as the real notifier', () => {
  const outcome = async (promise: Promise<unknown>): Promise<string> => {
    const error = await promise.then(() => undefined, (caught: unknown) => caught as Error);
    return error === undefined ? 'ok' : `${error.constructor.name}: ${error.message}`;
  };
  const chatUrl = 'https://chat.example.com/hooks/abc';

  it.each([
    ['an empty address and a bad raw format', { to: { url: '' }, text: 'x', raw: { slack: 5 } }],
    ['an empty address and a driver that does not exist', { to: { url: '', driver: 'missing' }, text: 'x' }],
    ['an empty address and an empty text', { to: { url: '' }, text: '' }],
    ['an empty address and a good message', { to: { url: '' }, text: 'x' }],
    ['an address of 2001 characters', { to: { url: `https://hooks.slack.com/services/${'a'.repeat(2001)}` }, text: 'x' }],
  ])('queue() and send() fail alike for %s', async (_name, message) => {
    const { chat, real } = await boot();
    const queued = await outcome(real.queue(message as never));
    expect(queued).not.toBe('ok');
    expect(await outcome(chat.queue(message as never))).toBe(queued);
    expect(await outcome(chat.send(message as never))).toBe(await outcome(real.send(message as never)));
    chat.assertNothingQueued().assertNothingSent();
  });

  it('names a missing queue before it refuses an address', async () => {
    const { chat, real } = await boot({ queue: false });
    const message = { to: { url: 'https://evil.example/x' }, text: 'x' };
    const expected = await outcome(real.queue(message));
    expect(expected).toMatch(/^ChatError: chat\.queue\(\) needs @marmeon\/queue/);
    expect(await outcome(chat.queue(message))).toBe(expected);
    expect(await outcome(chat.queue({ to: { url: '' }, text: 'x' }))).toBe(expected);
  });

  it('classifies the refusals as the real notifier does', async () => {
    const { chat } = await boot();
    expect((await rejection(chat.queue({ to: { url: '' }, text: 'x' }))).name).toBe('ChatAddressError');
    expect((await rejection(chat.queue({ to: { url: '', driver: 'missing' }, text: 'x' }))).name).toBe('ChatError');
    expect((await rejection(chat.queue({ to: { url: '' }, text: 'x', raw: { slack: 5 } } as never))).name).toBe('ChatError');
  });

  it('builds a driver again after its factory threw once, in the fake and in the real notifier', async () => {
    let builds = 0;
    const flaky = (): { hosts: string[]; paths: string[]; render: () => { json: { text: string } } } => {
      builds += 1;
      if (builds === 1 || builds === 2) throw new Error('not yet');
      return { hosts: ['chat.example.com'], paths: ['/hooks/'], render: () => ({ json: { text: 'x' } }) };
    };
    const provider = class { static chatDrivers = { flaky } as never; };
    const { chat, real } = await boot({ extra: [provider as ServiceProviderClass] });
    const message = { to: { url: chatUrl, driver: 'flaky' }, text: 'x' };
    const first = await outcome(chat.queue(message));
    expect(first).toMatch(/^ChatDriverError: /);
    // each notifier is told apart from the other by what it threw: the real one takes the second build
    expect(await outcome(real.queue(message))).toMatch(/^ChatDriverError: /);
    expect(await outcome(chat.queue(message))).toBe('ok');
    expect(await outcome(real.queue(message))).toBe('ok');
    chat.assertQueuedCount(1);
  });
});
