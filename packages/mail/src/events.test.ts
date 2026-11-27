import { Clock, createApplication, EventDispatcher, listen, Logger, Redactor, token, type Application, type Container } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { Queue, QueueServiceProvider, type JobContext } from '@marmeon/queue';
import { QueueFake } from '@marmeon/queue/testing';
import { describe, expect, it } from 'vitest';
import { fromHtml, html, Mailer, MailSent, MailServiceProvider, MailTransport, type Mailable, type MailMessage, type MailReceipt } from './index.ts';
import { mailSentReporter } from './events.ts';
import { SendQueuedMail } from './queued.ts';
import { TransportMailer } from './mailer.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class ResetMail implements Mailable {
  envelope() {
    return { to: [{ address: 'ada@example.com', name: 'Ada' }], cc: 'cc@example.com', bcc: 'bcc@example.com', subject: 'Reset your password', headers: { 'List-Unsubscribe': '<https://app.test/unsubscribe/secret-unsubscribe-token>' } };
  }
  content() {
    return fromHtml(html`<p><a href="https://app.test/reset?token=secret-reset-token">Choose a new password</a></p>`);
  }
  attachments() {
    return [{ filename: 'invoice.txt', content: 'secret-attachment-body' }];
  }
}

class Recording implements MailTransport {
  readonly sent: MailMessage[] = [];
  receipt: MailReceipt | undefined = { messageId: 'provider-id-1' };
  readonly failure: Error | undefined;
  constructor(failure?: Error) {
    this.failure = failure;
  }
  async send(message: MailMessage): Promise<MailReceipt> {
    if (this.failure) throw this.failure;
    this.sent.push(message);
    return this.receipt as MailReceipt;
  }
}

function withReceipt(receipt: MailReceipt | undefined): Recording {
  const transport = new Recording();
  transport.receipt = receipt;
  return transport;
}

class Collect {
  static readonly seen: MailSent[] = [];
  static #waiting: { count: number; resolve: () => void }[] = [];
  /** Resolves once `count` events arrived: the worker does not wait for its listeners. */
  static arrived(count: number): Promise<void> {
    return Collect.seen.length >= count ? Promise.resolve() : new Promise((resolve) => Collect.#waiting.push({ count, resolve }));
  }
  handle(event: MailSent): void {
    Collect.seen.push(event);
    Collect.#waiting = Collect.#waiting.filter((entry) => (Collect.seen.length >= entry.count ? (entry.resolve(), false) : true));
  }
}

class Explode {
  static calls = 0;
  static message = 'listener broke';
  handle(): void {
    Explode.calls++;
    throw new Error(Explode.message);
  }
}

const Scoped = token<{ readonly id: number }>('Scoped');

/** A listener with a scoped dependency: the root container cannot build it. */
class NeedsScope {
  static readonly inject = [Scoped];
  static built = 0;
  constructor(_scoped: { readonly id: number }) {
    NeedsScope.built++;
  }
  handle(): void {}
}

class Hang {
  static release: (() => void) | undefined;
  static calls = 0;
  handle(): Promise<void> {
    Hang.calls++;
    return new Promise((resolve) => (Hang.release = resolve));
  }
}

const warnWaiters: (() => void)[] = [];

/** Resolves once `warned` holds `count` warnings: the worker does not wait for its listeners, so the log is the signal. */
async function warnings(warned: string[], count: number): Promise<void> {
  while (warned.length < count) await new Promise<void>((resolve) => warnWaiters.push(resolve));
}

async function app(transport: MailTransport, listener: object, warned: string[] = [], driver = 'array', extra: (c: Container) => void = () => undefined): Promise<Application> {
  const logger: Logger = { debug() {}, info() {}, error() {}, warn: (message) => (warned.push(message), void warnWaiters.splice(0).forEach((resolve) => resolve())), child: () => logger };
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, QueueServiceProvider, MailServiceProvider],
    listeners: [listen(MailSent, listener as typeof Collect)],
  }, {
    env: { APP_KEY: KEY, NODE_ENV: 'test', MAIL_DRIVER: driver, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' },
    override: (c) => {
      c.instance(Clock, new TestClock());
      c.instance(MailTransport, transport);
      c.instance(Queue, new QueueFake(c));
      c.instance(Logger, logger);
      extra(c);
    },
  });
}

describe('MailSent', () => {
  it('is dispatched once by send() with the provider id, the driver and queued: false', async () => {
    Collect.seen.length = 0;
    const application = await app(new Recording(), Collect);
    const sent = await application.container.make(Mailer).send(new ResetMail());
    expect(sent.messageId).toBe('provider-id-1');
    expect(Collect.seen).toHaveLength(1);
    const [event] = Collect.seen;
    expect(event).toBeInstanceOf(MailSent);
    expect({ ...event }).toEqual({
      mailable: 'ResetMail',
      driver: 'array',
      messageId: 'provider-id-1',
      to: ['ada@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Reset your password',
      queued: false,
    });
    await application.shutdown();
  });

  it('is dispatched by the worker of a queued mail with the provider id and queued: true', async () => {
    Collect.seen.length = 0;
    const application = await app(withReceipt({ messageId: 'worker-id-9' }), Collect);
    await application.container.make(Mailer).queue(new ResetMail());
    expect(Collect.seen).toHaveLength(0);
    expect(await (application.container.make(Queue) as QueueFake).work()).toMatchObject({ processed: 1, failed: 0 });
    await Collect.arrived(1);
    expect(Collect.seen).toHaveLength(1);
    expect(Collect.seen[0]).toMatchObject({ mailable: 'ResetMail', messageId: 'worker-id-9', queued: true, to: ['ada@example.com'] });
    await application.shutdown();
  });

  it('has no messageId when the transport returns none', async () => {
    Collect.seen.length = 0;
    const application = await app(withReceipt(undefined), Collect);
    await application.container.make(Mailer).send(new ResetMail());
    expect(Collect.seen[0]!.messageId).toBeUndefined();
    await application.shutdown();
  });

  it('is not dispatched when the transport throws', async () => {
    Collect.seen.length = 0;
    const application = await app(new Recording(new Error('connect ECONNREFUSED')), Collect);
    await expect(application.container.make(Mailer).send(new ResetMail())).rejects.toThrow('ECONNREFUSED');
    await application.container.make(Mailer).queue(new ResetMail());
    await (application.container.make(Queue) as QueueFake).work();
    expect(Collect.seen).toHaveLength(0);
    await application.shutdown();
  });

  it('logs a listener that throws and still resolves send() once, with the transport called once and no mail text in the log', async () => {
    Explode.calls = 0;
    const warned: string[] = [];
    const transport = new Recording();
    const application = await app(transport, Explode, warned);
    const sent = await application.container.make(Mailer).send(new ResetMail());
    expect(sent.messageId).toBe('provider-id-1');
    expect(transport.sent).toHaveLength(1);
    expect(Explode.calls).toBe(1);
    expect(warned).toEqual(['A listener of MailSent failed: listener broke']);
    await application.shutdown();
  });

  it('ends the job successfully when a listener throws, and the transport takes the mail once', async () => {
    Explode.calls = 0;
    const warned: string[] = [];
    const transport = new Recording();
    const application = await app(transport, Explode, warned);
    await application.container.make(Mailer).queue(new ResetMail());
    expect(await (application.container.make(Queue) as QueueFake).work()).toMatchObject({ processed: 1, failed: 0 });
    await warnings(warned, 1);
    expect(transport.sent).toHaveLength(1);
    expect(Explode.calls).toBe(1);
    expect(warned).toEqual(['A listener of MailSent failed: listener broke']);
    await application.shutdown();
  });

  it('carries metadata only: no html, text, attachments or headers, and the arrays are frozen', async () => {
    Collect.seen.length = 0;
    const application = await app(new Recording(), Collect);
    await application.container.make(Mailer).send(new ResetMail());
    const [event] = Collect.seen;
    expect(Object.keys(event!).sort()).toEqual(['bcc', 'cc', 'driver', 'mailable', 'messageId', 'queued', 'subject', 'to']);
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(Object.isFrozen(event!.to)).toBe(true);
    expect(Object.isFrozen(event!.cc)).toBe(true);
    expect(Object.isFrozen(event!.bcc)).toBe(true);
    await application.shutdown();
  });

  it('names the configured driver', async () => {
    Collect.seen.length = 0;
    const application = await app(new Recording(), Collect, [], 'log');
    await application.container.make(Mailer).send(new ResetMail());
    expect(Collect.seen[0]!.driver).toBe('log');
    await application.shutdown();
  });

  it('has no messageId on the worker path when the transport returns no receipt', async () => {
    Collect.seen.length = 0;
    const application = await app(withReceipt(undefined), Collect);
    await application.container.make(Mailer).queue(new ResetMail());
    await (application.container.make(Queue) as QueueFake).work();
    await Collect.arrived(1);
    expect(Collect.seen).toHaveLength(1);
    expect(Collect.seen[0]!.messageId).toBeUndefined();
    await application.shutdown();
  });

  it('redacts secrets in the error message of a listener before it logs it', async () => {
    const secret = ['abc', 'def', 'ghi', 'jkl'].join('');
    Explode.message = `upstream said Authorization: Bearer ${secret}`;
    const warned: string[] = [];
    const application = await app(new Recording(), Explode, warned);
    await application.container.make(Mailer).send(new ResetMail());
    Explode.message = 'listener broke';
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBe('A listener of MailSent failed: upstream said Authorization: Bearer [redacted]');
    expect(warned[0]).not.toContain(secret);
    await application.shutdown();
  });

  it('builds the listeners from the root container on both paths: a scoped dependency is logged and the mail counts as sent', async () => {
    const warned: string[] = [];
    const transport = new Recording();
    const application = await app(transport, NeedsScope, warned, 'array', (c) => c.scoped(Scoped, () => ({ id: 1 })));
    const sent = await application.container.make(Mailer).send(new ResetMail());
    expect(sent.messageId).toBe('provider-id-1');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('A listener of MailSent failed:');
    expect(warned[0]).toContain('scoped');
    await application.container.make(Mailer).queue(new ResetMail());
    expect(await (application.container.make(Queue) as QueueFake).work()).toMatchObject({ processed: 1, failed: 0 });
    await warnings(warned, 2);
    expect(transport.sent).toHaveLength(2);
    expect(warned).toHaveLength(2);
    expect(warned[1]).toContain('scoped');
    expect(NeedsScope.built).toBe(0);
    await application.shutdown();
  });

  it('ends the job without waiting for a listener that is still running, and the transport took the mail once', async () => {
    Hang.calls = 0;
    const transport = new Recording();
    const application = await app(transport, Hang);
    await application.container.make(Mailer).queue(new ResetMail());
    // work() resolves while the listener has not: a stopping worker has nothing to wait for, so nothing releases the job to a retry.
    expect(await (application.container.make(Queue) as QueueFake).work()).toMatchObject({ processed: 1, failed: 0, released: 0 });
    expect(Hang.calls).toBe(1);
    expect(transport.sent).toHaveLength(1);
    Hang.release?.();
    await application.shutdown();
  });

  it('handle() resolves while the listener is pending, with a signal that never aborts', async () => {
    Hang.calls = 0;
    const transport = new Recording();
    const application = await app(transport, Hang);
    const { toQueued } = await import('./queued.ts');
    const { compose } = await import('./mailer.ts');
    const payload = { mailable: 'ResetMail', message: toQueued(await compose(new ResetMail(), 'hello@app.test')) };
    const job = { id: 'job-1', name: 'marmeon.mail', attempt: 1, tries: 5, queue: 'default', connection: 'database', signal: new AbortController().signal, discard: () => undefined, release: () => undefined, fail: () => undefined, once: async () => true } as JobContext;
    await application.container.make(SendQueuedMail).handle(payload, job);
    expect(Hang.calls).toBe(1);
    expect(transport.sent).toHaveLength(1);
    Hang.release?.();
    await application.shutdown();
  });

});

describe('the MailSent reporter', () => {
  const message: MailMessage = { from: { address: 'a@b.test' }, to: [{ address: 'c@d.test' }], cc: [], bcc: [], subject: 's', html: '', text: '', attachments: [], headers: {} };
  const logger = { debug() {}, info() {}, error() {}, warn() {}, child: () => logger } as Logger;

  it('resolves when the dispatcher cannot be built and the send still resolves with its messageId', async () => {
    const report = mailSentReporter('array', () => { throw new Error('no dispatcher'); }, () => logger, () => new Redactor());
    await expect(report({ mailable: 'M', message, messageId: 'x', queued: false })).resolves.toBeUndefined();
    const mailer = new TransportMailer(new Recording(), 'from@app.test', undefined, undefined, report);
    expect((await mailer.send(new ResetMail())).messageId).toBe('provider-id-1');
  });

  it('resolves when the logger throws too', async () => {
    const failing = { dispatch: async () => { throw new Error('listener'); } } as unknown as EventDispatcher;
    const report = mailSentReporter('array', () => failing, () => { throw new Error('no logger'); }, () => new Redactor());
    await expect(report({ mailable: 'M', message, messageId: undefined, queued: true })).resolves.toBeUndefined();
    const mailer = new TransportMailer(new Recording(), 'from@app.test', undefined, undefined, report);
    expect((await mailer.send(new ResetMail())).messageId).toBe('provider-id-1');
  });
});
