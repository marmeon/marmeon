import { join } from 'node:path';
import { Clock, createApplication, Logger, TestClock, type Application, type LogContext } from '@bespokecore/core';
import { EncryptionServiceProvider } from '@bespokecore/encryption';
import { Queue, QueueFake, QueueServiceProvider } from '@bespokecore/queue';
import { Router } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import {
  ArrayTransport,
  calendarEvent,
  fromHtml,
  html,
  MailError,
  Mailer,
  MailFake,
  MailPreviews,
  MailServiceProvider,
  MailTransport,
  SendQueuedMail,
  TransportMailer,
  type Mailable,
  type MailMessage,
  type QueuedMailPayload,
} from './index.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class ResetMail implements Mailable {
  readonly #url: string;
  readonly #attachments: boolean;
  constructor(url: string, attachments = false) {
    this.#url = url;
    this.#attachments = attachments;
  }
  envelope() {
    return { to: { address: 'ada@example.com', name: 'Ada' }, subject: 'Reset your password', replyTo: 'help@app.test' };
  }
  content() {
    return fromHtml(html`<p><a href="${this.#url}">Choose a new password</a></p>`);
  }
  attachments() {
    return this.#attachments ? [{ filename: 'a.bin', content: new Uint8Array([0, 1, 254, 255]), contentType: 'application/octet-stream' }, { filename: 'b.txt', content: 'plain' }] : [];
  }
}

/** A transport that fails until told otherwise — an SMTP server that is down. */
class FlakyTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  down = true;
  async send(message: MailMessage): Promise<void> {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:587');
    this.sent.push(message);
  }
}

async function app(env: Record<string, string> = {}, transport: MailTransport = new ArrayTransport()): Promise<Application> {
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { LOG_LEVEL: 'silent', APP_KEY: KEY, QUEUE_CONNECTION: 'sync', QUEUE_FAILED_DRIVER: 'null', ...env },
    providers: [EncryptionServiceProvider, QueueServiceProvider, MailServiceProvider],
    override: (c) => {
      c.instance(Clock, new TestClock());
      c.instance(MailTransport, transport);
      c.instance(Queue, new QueueFake(c));
    },
  });
}

describe('mailer.queue() (E105)', () => {
  it('composes now, queues an encrypted bespoke.mail job, and a worker hands the message to the transport', async () => {
    const transport = new FlakyTransport();
    transport.down = false;
    const application = await app({}, transport);
    const url = 'https://app.test/reset-password?token=plain-reset-token-123&email=ada%40example.com';
    const message = await application.container.make(Mailer).queue(new ResetMail(url, true), { queue: 'mail', delay: 30 });
    expect(message.subject).toBe('Reset your password'); // composed now
    expect(transport.sent).toEqual([]);

    const queue = application.container.make(Queue) as QueueFake;
    const [dispatched] = queue.dispatched(SendQueuedMail);
    expect(dispatched).toMatchObject({ queue: 'mail', delay: 30, payload: { mailable: 'ResetMail' } });
    const stored = queue.pending().map((entry) => entry.payload).join('\n');
    expect(stored).toContain('"job":"bespoke.mail"');
    expect(stored).not.toContain('plain-reset-token-123'); // E105: no plaintext link in the queue
    expect(stored).not.toContain('ada@example.com');

    expect(await queue.work()).toMatchObject({ processed: 0 }); // delayed by 30 s
    (application.container.make(Clock) as TestClock).travel({ seconds: 30 });
    expect(await queue.work()).toMatchObject({ processed: 1, failed: 0 });
    expect(transport.sent).toHaveLength(1);
    const [sent] = transport.sent;
    expect(sent).toEqual(message); // the composed message, attachments and all — binary ones survive the JSON
    expect(sent!.attachments[0]!.content).toEqual(new Uint8Array([0, 1, 254, 255]));
    expect(sent!.html).toContain('plain-reset-token-123');
  });

  it('retries a transport that fails (10 s, 1 min, 5 min, 5 min) and keeps the job, still encrypted, in the failed jobs after its five tries', async () => {
    const transport = new FlakyTransport();
    const application = await app({}, transport);
    await application.container.make(Mailer).queue(new ResetMail('https://app.test/reset'));
    const queue = application.container.make(Queue) as QueueFake;
    const clock = application.container.make(Clock) as TestClock;
    // Five attempts, 10 s, 1 min, 5 min, 5 min apart (the last backoff repeats).
    for (const wait of [0, 10, 60, 300]) {
      clock.travel({ seconds: wait });
      expect(await queue.work()).toMatchObject({ released: 1, failed: 0 });
    }
    clock.travel({ seconds: 299 });
    expect(await queue.work()).toMatchObject({ processed: 0 }); // not due yet
    clock.travel({ seconds: 1 });
    expect(await queue.work()).toMatchObject({ released: 0, failed: 1 });
    expect(transport.sent).toEqual([]);
    expect(queue.pending()).toEqual([]);
    const [failed] = await queue.failed();
    expect(failed).toMatchObject({ job: 'bespoke.mail', queue: 'default' });
    expect(failed!.exception).toContain('ECONNREFUSED');
    expect(failed!.payload).not.toContain('ada@example.com'); // still encrypted in the failed jobs
  });

  it('needs @bespokecore/queue — the error says what to do', async () => {
    const mailer = new TransportMailer(new ArrayTransport(), 'team@app.test');
    await expect(mailer.queue(new ResetMail('https://app.test/x'))).rejects.toThrow(
      'mailer.queue() needs @bespokecore/queue (pnpm add @bespokecore/queue; bespoke discover) — or send the mail now: mailer.send().',
    );
  });

  it('refuses relative links — a mail composed in a worker has no request to take a host from', async () => {
    const mailer = new MailFake();
    await expect(mailer.queue(new ResetMail('/reset-password?token=abc'))).rejects.toThrow(
      'ResetMail links to "/reset-password?token=abc" — a link in a mail must be absolute. Build it from APP_URL',
    );
    await expect(mailer.send(new ResetMail('../reset'))).rejects.toThrow(MailError);
    await expect(mailer.send(new ResetMail('https://app.test/reset'))).resolves.toBeDefined();
    await expect(mailer.send(new ResetMail('mailto:help@app.test'))).resolves.toBeDefined();
  });
});

describe('MailFake: queued apart from sent', () => {
  it('records queued mails (composed, with their options) and points at the other list when an assertion misses', async () => {
    const mail = new MailFake();
    await mail.queue(new ResetMail('https://app.test/r'), { queue: 'mail' });
    mail.assertQueued(ResetMail).assertQueued(ResetMail, (_mail, message, options) => message.to[0]!.address === 'ada@example.com' && options.queue === 'mail').assertQueuedCount(ResetMail, 1);
    mail.assertNothingSent().assertNotSent(ResetMail);
    expect(() => mail.assertSent(ResetMail)).toThrow('Expected a ResetMail to be sent (ResetMail was queued, not sent now — assertQueued). Sent: nothing.');
    await mail.send(new ResetMail('https://app.test/s'));
    expect(() => mail.assertNothingQueued()).toThrow('Expected no queued mail, queued ResetMail.');
    const fresh = new MailFake();
    await fresh.send(new ResetMail('https://app.test/s'));
    expect(() => fresh.assertQueued(ResetMail)).toThrow('Expected a ResetMail to be queued (ResetMail was sent now, not queued — assertSent). Queued: nothing.');
  });
});

describe('MailServiceProvider', () => {
  it('builds the transport only when a mail is sent — a process that never sends closes none at shutdown', async () => {
    const children: LogContext[] = [];
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: (context) => (children.push(context), logger) };
    const quiet = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [MailServiceProvider], override: (c) => c.instance(Logger, logger) });
    await quiet.shutdown();
    expect(children).toEqual([]); // the log transport (channel mail) was never built

    const used = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [MailServiceProvider], override: (c) => c.instance(Logger, logger) });
    await used.container.make(Mailer).send(new ResetMail('https://app.test/r'));
    await used.shutdown();
    expect(children).toEqual([{ channel: 'mail' }]);
  });

  it('registers bespoke.mail as a framework job when the app has the queue', async () => {
    const application = await app();
    const { JobRegistry } = await import('@bespokecore/queue');
    expect(application.container.make(JobRegistry).get('bespoke.mail')).toBe(SendQueuedMail);
  });
});

describe('calendarEvent() (.ics)', () => {
  it('writes an RFC 5545 event: CRLF lines, UTC times, escaped text, folded long lines', () => {
    const attachment = calendarEvent({
      uid: 'booking-42@app.test',
      summary: 'Consultation, room 2; bring\\notes',
      description: `Line one\nLine two — ${'ä'.repeat(60)}`,
      start: new Date('2026-12-24T17:00:00Z'),
      end: new Date('2026-12-24T18:30:00Z'),
      stamp: new Date('2026-10-03T08:00:00Z'),
      url: 'https://app.test/bookings/42',
      organizer: { address: 'team@app.test', name: 'The "Team"' },
      method: 'REQUEST',
    });
    expect(attachment.filename).toBe('event.ics');
    expect(attachment.contentType).toBe('text/calendar; charset=utf-8; method=REQUEST');
    const content = attachment.content as string;
    expect(content.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(content).toContain('\r\nDTSTART:20261224T170000Z\r\nDTEND:20261224T183000Z\r\n');
    expect(content).toContain('DTSTAMP:20261003T080000Z');
    expect(content).toContain('SUMMARY:Consultation\\, room 2\\; bring\\\\notes');
    expect(content).toContain('ORGANIZER;CN="The Team":mailto:team@app.test');
    for (const line of content.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    // Unfolded, the description is whole again — and its line break is the escaped \n, not a new property.
    const unfolded = content.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:Line one\\nLine two — ${'ä'.repeat(60)}\r\n`);
  });

  it('all-day events use dates; a line break where one line belongs is refused — no property smuggled in', () => {
    const content = calendarEvent({ uid: 'day@app.test', summary: 'Holiday', start: new Date('2026-12-25T00:00:00Z'), allDay: true, stamp: new Date(0) }).content as string;
    expect(content).toContain('DTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261226\r\n');
    const unfolded = calendarEvent({ uid: 'x@app.test', summary: 'Evil\r\nATTENDEE:mailto:victim@example.com', start: new Date(0), end: new Date(1000) }).content as string;
    expect(unfolded).not.toMatch(/\r\nATTENDEE/);
    expect(() => calendarEvent({ uid: 'x\r\nATTENDEE:mailto:v@example.com', summary: 's', start: new Date(0), end: new Date(1000) })).toThrow(MailError);
    expect(() => calendarEvent({ uid: 'x', summary: 's', start: new Date(0), end: new Date(1000), url: '/relative' })).toThrow('absolute http(s) link');
    expect(() => calendarEvent({ uid: 'x', summary: 's', start: new Date(1000), end: new Date(0) })).toThrow('ends after it starts');
    expect(() => calendarEvent({ uid: 'x', summary: 's', start: new Date(0), end: new Date(1000), method: 'REQUEST' })).toThrow('needs an organizer');
  });
});

describe('mail previews (E106)', () => {
  const root = join(import.meta.dirname, '__fixtures__', 'preview-app');
  const previewApp = (environment = 'development', override: (c: import('@bespokecore/core').Container) => void = () => {}) =>
    createApplication({ root, discover: false, env: environment ? { NODE_ENV: environment } : {}, providers: [MailServiceProvider], override: (c) => (c.instance(Router, new Router()), override(c)) });

  it('lists the mails with static preview() and shows one — header, the HTML in a sandboxed frame, ?text, ?raw, ?locale', async () => {
    const application = await previewApp();
    const previews = application.container.make(MailPreviews);
    expect([...(await previews.all()).keys()]).toEqual(['shop/OrderShippedMail']);
    expect(await (await previews.index()).text()).toContain('<a href="/_bespoke/mail/shop/OrderShippedMail">shop/OrderShippedMail</a>');

    const page = await previews.show('shop/OrderShippedMail', new URL('http://localhost/_bespoke/mail/shop/OrderShippedMail?locale=de'));
    expect(page.headers.get('cache-control')).toBe('no-store');
    // Its own policy (E147): no script at all — an app's contentSecurityPolicy() leaves it alone; the srcdoc frame inherits it.
    expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'unsafe-inline'; .*frame-ancestors 'self'$/);
    expect(page.headers.get('content-security-policy')).not.toContain('script-src');
    const body = await page.text();
    expect(body).toContain('<th>Subject</th><td>Deine Bestellung ist unterwegs</td>');
    expect(body).toContain('<iframe sandbox ');
    expect(body).not.toContain('<script>alert(1)</script>'); // the template's markup only inside srcdoc, escaped
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(await (await previews.show('shop/OrderShippedMail', new URL('http://localhost/x?text'))).text()).toContain('Hello Ada <script>');
    const raw = await previews.show('shop/OrderShippedMail', new URL('http://localhost/x?raw'));
    expect(raw.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toBe('sandbox'); // opened alone: still no script of the template
    expect((await previews.show('../../package.json', new URL('http://localhost/x'))).status).toBe(404);
    expect((await previews.show('shop/InternalMail', new URL('http://localhost/x'))).status).toBe(404);

    const paths = application.container.make(Router).routes.map((route) => route.path);
    expect(paths).toEqual(expect.arrayContaining(['/_bespoke/mail', '/_bespoke/mail/:module/:mail']));
  });

  // E115 (W7 step 8): development only — not "anything but production" (a test, staging or a server without NODE_ENV).
  it.each([['production'], ['test'], ['staging'], ['']])('is not registered with NODE_ENV=%j (empty: unset)', async (environment) => {
    const application = await previewApp(environment);
    expect(application.container.make(Router).routes.map((route) => route.path)).not.toContain('/_bespoke/mail');
    expect(application.container.has(MailPreviews)).toBe(false);
  });
});

// Never called: only the types matter.
export function queuedTypes(payload: QueuedMailPayload): void {
  void payload.message.attachments[0]?.encoding;
}
