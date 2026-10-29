import { createServer, type Server } from 'node:net';
import { ConsoleLogger, createApplication, Logger, type Container, type LogContext, type ServiceProviderClass } from '@marmeon/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  fromHtml,
  html,
  MailError,
  mjml,
  MjmlError,
  Mailer,
  MailServiceProvider,
  MailTransport,
  raw,
  type MailDriverFactory,
  type MailReceipt,
  type SentMail,
  type Mailable,
  type MailContent,
  type MailMessage,
} from './index.ts';
import { compose } from './mailer.ts';
import { ArrayTransport, LogTransport, SmtpTransport } from './transports.ts';
import { fromDefaultWarning, LOG_MAILER_WARNING } from './config.ts';
import { MailFake } from './fake.ts';
import { textFromHtml } from './html.ts';

class WelcomeMail implements Mailable {
  readonly #name: string;
  readonly #email: string;
  constructor(name: string, email = 'ada@example.com') {
    this.#name = name;
    this.#email = email;
  }
  envelope() {
    return { to: { address: this.#email, name: this.#name }, subject: `Welcome, ${this.#name}` };
  }
  content() {
    return fromHtml(html`<h1>Hello ${this.#name}</h1><p>Start here: <a href="${'https://app.test/start?a=1&b=2'}">Your profile</a></p>`);
  }
}

describe('html``', () => {
  it('escapes every value — a name cannot inject markup', () => {
    const name = '<img src=x onerror="alert(1)">';
    expect(String(html`<p>Hello ${name}</p>`)).toBe('<p>Hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
    expect(String(html`<a title='${"x' onmouseover='alert(1)"}'>`)).toBe(`<a title='x&#39; onmouseover=&#39;alert(1)'>`);
    // Without the template — plain interpolation — the markup would go through as it is:
    expect(`<p>Hello ${name}</p>`).toContain('<img');
  });

  it('keeps nested templates and raw() markup, joins arrays, drops null/undefined/false', () => {
    const items = ['a<b', 'c'];
    expect(String(html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>${null}${undefined}${false}${0}${raw('<hr>')}`)).toBe(
      '<ul><li>a&lt;b</li><li>c</li></ul>0<hr>',
    );
  });

  it('derives a text version: line breaks for blocks, URLs kept next to link labels, entities decoded', () => {
    const markup = String(html`<style>p{color:red}</style><h1>Hi &amp; welcome</h1><p>Line<br>two</p><ul><li>one</li><li>two</li></ul><p><a href="${'https://x.test/?a=1&b=2'}">Go</a></p>`);
    expect(textFromHtml(markup)).toBe('Hi & welcome\n\nLine\ntwo\n\n- one\n- two\n\nGo (https://x.test/?a=1&b=2)');
  });
});

class ResetMail implements Mailable {
  readonly #name: string;
  constructor(name: string) {
    this.#name = name;
  }
  envelope() {
    return { to: 'ada@example.com', subject: 'Reset your password' };
  }
  content() {
    return mjml`<mjml>
      <mj-head><mj-preview>A link to choose a new password</mj-preview></mj-head>
      <mj-body><mj-section><mj-column>
        <mj-text>Hello ${this.#name},</mj-text>
        <mj-button href="${'https://app.test/reset-password?token=abc&email=ada%40example.com'}">Choose a new password</mj-button>
      </mj-column></mj-section></mj-body>
    </mjml>`;
  }
}

describe('mjml``', () => {
  it('compiles to mail-client HTML — tables and Outlook conditionals — with a readable text version', async () => {
    const message = await compose(new ResetMail('Ada'), 'hello@app.test');
    expect(message.html).toMatch(/^<!doctype html>/i);
    expect(message.html).toContain('<!--[if mso');
    expect(message.html).toContain('<table');
    expect(message.text).toBe('Hello Ada,\n\nChoose a new password (https://app.test/reset-password?token=abc&email=ada%40example.com)');
  });

  it('escapes values — a name cannot inject markup or MJML', async () => {
    const message = await compose(new ResetMail('<mj-raw><img src=x onerror="alert(1)"></mj-raw>'), 'hello@app.test');
    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&lt;mj-raw&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('validates strictly: a mistyped tag is an error, not a silently missing button', async () => {
    const typo = { envelope: () => ({ to: 'a@b.test', subject: 'x' }), content: () => mjml`<mjml><mj-body><mj-buton>x</mj-buton></mj-body></mjml>` };
    await expect(compose(typo, 'hello@app.test')).rejects.toThrow(MjmlError);
  });

  it('without mjml (an optional peer) says what to install — with the tested major; a broken install passes through', async () => {
    const { loadMjml } = await import('./mjml.ts');
    const missing = Object.assign(new Error("Cannot find package 'mjml' imported from /app/node_modules/@marmeon/mail/dist/mjml.js"), { code: 'ERR_MODULE_NOT_FOUND' });
    const message = await loadMjml(() => Promise.reject(missing)).then(() => 'loaded', (error: Error) => error.message);
    // The message as the assertion's text: the whole command shows when it differs (Vitest shortens long strings).
    expect(message, message).toBe('[marmeon:Q7] mjml`` needs the mjml package, which is not installed in this app: pnpm add mjml@^5');
    await expect(loadMjml(() => Promise.reject(new SyntaxError('Unexpected token')))).rejects.toThrow(SyntaxError);
  });
});

describe('compose()', () => {
  it('builds the neutral message: default sender, addresses normalized, text derived', async () => {
    const message = await compose(new WelcomeMail('Ada'), { address: 'hello@app.test', name: 'App' });
    expect(message).toMatchObject({
      from: { address: 'hello@app.test', name: 'App' },
      to: [{ address: 'ada@example.com', name: 'Ada' }],
      cc: [],
      bcc: [],
      subject: 'Welcome, Ada',
      attachments: [],
    });
    expect(message.text).toBe('Hello Ada\n\nStart here: Your profile (https://app.test/start?a=1&b=2)');
  });

  it('refuses line breaks in headers — no Bcc smuggled in through a subject or a name', async () => {
    await expect(compose(new WelcomeMail('Ada\r\nBcc: everyone@evil.test'), 'hello@app.test')).rejects.toThrow(MailError);
    const withHeader = { envelope: () => ({ to: 'a@b.test', subject: 'x', headers: { 'X-Tag': 'a\nBcc: c@d.test' } }), content: () => ({ html: '', text: '' }) };
    await expect(compose(withHeader, 'hello@app.test')).rejects.toThrow('header X-Tag must be a single line');
    const badAddress = { envelope: () => ({ to: 'a@b.test, c@d.test', subject: 'x' }), content: () => ({ html: '', text: '' }) };
    await expect(compose(badAddress, 'hello@app.test')).rejects.toThrow('Invalid mail address');
  });

  it('needs { html, text } strings — and at least one recipient', async () => {
    const wrong = { envelope: () => ({ to: 'a@b.test', subject: 'x' }), content: () => ({ $$typeof: Symbol.for('react.element') }) as unknown as MailContent };
    await expect(compose(wrong, 'hello@app.test')).rejects.toThrow('must return mjml`…`, html`…` or { html, text } strings');
    await expect(compose({ envelope: () => ({ to: [], subject: 'x' }), content: () => ({ html: '', text: '' }) }, 'hello@app.test')).rejects.toThrow('has no recipient');
  });
});

describe('transports', () => {
  it('log: writes recipient, subject and the text version (links clickable in development)', async () => {
    const lines: string[] = [];
    class Capture extends ConsoleLogger {
      override info(message: string, _context?: LogContext) {
        lines.push(message);
      }
      override child(): Logger {
        return this;
      }
    }
    const receipt = await new LogTransport(new Capture()).send(await compose(new WelcomeMail('Ada'), 'hello@app.test'));
    expect(receipt, 'no provider took part').toEqual({ messageId: undefined });
    expect(lines).toEqual(['Mail to ada@example.com: Welcome, Ada\n\nHello Ada\n\nStart here: Your profile (https://app.test/start?a=1&b=2)\n']);
  });

  it('smtp: hands the message to an SMTP server through nodemailer — text and HTML parts', async () => {
    let receipt: MailReceipt | undefined;
    const received = await withSmtpServer(async (port) => {
      // The test server has no TLS: the opt-out (a local server like Mailpit).
      const transport = new SmtpTransport({ host: '127.0.0.1', port, secure: false, requireTls: false });
      receipt = await transport.send(await compose(new WelcomeMail('Ada'), { address: 'hello@app.test', name: 'App' }));
      await transport.close();
    });
    expect(receipt?.messageId, "nodemailer's message id").toMatch(/^<.+@.+>$/);
    expect(received.data).toContain(`Message-ID: ${receipt?.messageId}`);
    expect(received.envelope).toEqual(['MAIL FROM:<hello@app.test>', 'RCPT TO:<ada@example.com>']);
    expect(received.data).toMatch(/^Subject: Welcome, Ada$/m);
    expect(received.data).toMatch(/^From: App <hello@app\.test>$/m);
    expect(received.data).toContain('Content-Type: text/plain');
    expect(received.data).toContain('Content-Type: text/html');
  });

  it('smtp: sends nothing to a server that does not upgrade to TLS — STARTTLS is required by default', async () => {
    let failure: unknown;
    const received = await withSmtpServer(async (port) => {
      const transport = new SmtpTransport({ host: '127.0.0.1', port, secure: false });
      failure = await transport.send(await compose(new WelcomeMail('Ada'), 'hello@app.test')).then(() => undefined, (error: unknown) => error);
      await transport.close();
    });
    expect(String(failure), 'a mail went out without TLS').toMatch(/STARTTLS/i);
    expect(received.envelope).toEqual([]);
    expect(received.data).toBe('');
  });

  it('asks nodemailer for STARTTLS unless MAIL_REQUIRE_TLS=false — implicit TLS (MAIL_SECURE) needs none', async () => {
    const created: Record<string, unknown>[] = [];
    vi.doMock('nodemailer', () => ({ default: { createTransport: (options: Record<string, unknown>) => (created.push(options), { sendMail: async () => {}, close() {} }) } }));
    try {
      const send = async (env: Record<string, string>) => {
        const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [MailServiceProvider] }, { env: { LOG_LEVEL: 'silent', MAIL_DRIVER: 'smtp', ...env } });
        await app.container.make(Mailer).send(new WelcomeMail('Ada'));
        await app.shutdown();
        return created.at(-1)!;
      };
      const tls = (options: Record<string, unknown>) => `port ${options.port}, secure ${options.secure}, requireTLS ${options.requireTLS}`;
      expect(tls(await send({})), 'the default').toBe('port 587, secure false, requireTLS true');
      expect(tls(await send({ MAIL_REQUIRE_TLS: 'false' })), 'the opt-out').toBe('port 587, secure false, requireTLS false');
      expect(tls(await send({ MAIL_SECURE: 'true', MAIL_PORT: '465' })), 'implicit TLS').toBe('port 465, secure true, requireTLS false');
    } finally {
      vi.doUnmock('nodemailer');
    }
  });
});

describe('MailServiceProvider', () => {
  const boot = (env: Record<string, string>, override?: (container: Container) => void) =>
    createApplication({ root: import.meta.dirname, discover: false, providers: [MailServiceProvider] }, { env: { LOG_LEVEL: 'silent', ...env }, ...(override ? { override } : {}) });

  it('picks the transport by MAIL_DRIVER and sends from MAIL_FROM_*', async () => {
    const app = await boot({ MAIL_DRIVER: 'array', MAIL_FROM_ADDRESS: 'team@app.test', MAIL_FROM_NAME: 'The Team' });
    const message = await app.container.make(Mailer).send(new WelcomeMail('Ada'));
    expect(message.from).toEqual({ address: 'team@app.test', name: 'The Team' });
    expect((app.container.make(MailTransport) as ArrayTransport).messages).toEqual([message]);
    expect((await boot({})).container.make(MailTransport)).toBeInstanceOf(LogTransport);
    expect((await boot({ MAIL_DRIVER: 'smtp' })).container.make(MailTransport)).toBeInstanceOf(SmtpTransport);
    await expect(boot({ MAIL_FROM_ADDRESS: 'nope' })).rejects.toThrow(/mail: MAIL_FROM_ADDRESS/);
  });

  it('warns once at boot when a protected environment runs on the log mailer — reset links would land in the log', async () => {
    const warningsWith = async (env: Record<string, string>) => {
      env = { MAIL_FROM_ADDRESS: 'team@app.test', ...env };
      const warnings: string[] = [];
      const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
      await boot(env, (container) => container.instance(Logger, logger));
      return warnings;
    };
    expect(await warningsWith({ NODE_ENV: 'production' })).toEqual([LOG_MAILER_WARNING]); // MAIL_DRIVER unset: the default
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_DRIVER: 'log' })).toEqual([LOG_MAILER_WARNING]);
    expect(LOG_MAILER_WARNING).toContain('no mail is sent');
    expect(LOG_MAILER_WARNING).toContain('in plain text');
    // Quiet with a real mailer, and in development and tests (there the log is where the links are clicked).
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_DRIVER: 'array' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'development' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'test' })).toEqual([]);
    // Fail-closed: a missing NODE_ENV is protected like production — APP_ENV changes nothing.
    expect(await warningsWith({ NODE_ENV: 'production', APP_ENV: 'local' })).toEqual([LOG_MAILER_WARNING]);
    expect(await warningsWith({ NODE_ENV: '' })).toEqual([LOG_MAILER_WARNING]);
  });

  it('warns once at boot when a protected environment sends from the default address', async () => {
    const warningsWith = async (env: Record<string, string>) => {
      const warnings: string[] = [];
      const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
      await boot(env, (container) => container.instance(Logger, logger));
      return warnings;
    };
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp' })).toEqual([fromDefaultWarning('smtp')]);
    expect(await warningsWith({ NODE_ENV: '', MAIL_DRIVER: 'smtp' })).toEqual([fromDefaultWarning('smtp')]);
    expect(fromDefaultWarning('smtp')).toContain('MAIL_FROM_ADDRESS is not set: mail goes out from hello@example.com');
    // On the log mailer both warnings apply, and the sender line says the mail is only logged.
    expect(await warningsWith({ NODE_ENV: 'production' })).toEqual([LOG_MAILER_WARNING, fromDefaultWarning('log')]);
    expect(fromDefaultWarning('log')).toContain('now only in the log');
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp', MAIL_FROM_ADDRESS: 'team@app.test' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'development', MAIL_DRIVER: 'smtp' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'test', MAIL_DRIVER: 'smtp' })).toEqual([]);
  });

  it('takes a transport of your own — a class against the neutral message type', async () => {
    class PostcardTransport implements MailTransport {
      readonly postcards: string[] = [];
      async send(message: MailMessage): Promise<MailReceipt> {
        this.postcards.push(`${message.to[0]!.address}: ${message.subject}`);
        return { messageId: undefined };
      }
    }
    const postcards = new PostcardTransport();
    const app = await boot({}, (container) => container.instance(MailTransport, postcards));
    await app.container.make(Mailer).send(new WelcomeMail('Ada'));
    expect(postcards.postcards).toEqual(['ada@example.com: Welcome, Ada']);
  });

  it('a transport must resolve with a receipt — one that returns nothing is a type error', () => {
    // @ts-expect-error send() resolves with void, not a MailReceipt
    const forgetful: MailTransport = { send: async (_message: MailMessage) => {} };
    expectTypeOf<Awaited<ReturnType<Mailer['send']>>>().toEqualTypeOf<SentMail>();
    expectTypeOf<SentMail>().toExtend<MailMessage>();
    expect(forgetful).toBeDefined();
  });
});

describe('mail drivers a provider brings', () => {
  const plugin = (name: string, mailDrivers: Record<string, MailDriverFactory> | undefined): ServiceProviderClass => ({ [name]: class { static mailDrivers = mailDrivers; } })[name]!;
  const ses: MailDriverFactory = ({ name }) => ({ send: async (message) => ({ messageId: `${name}-${message.subject}` }) });
  const boot = (providers: ServiceProviderClass[], env: Record<string, string>) =>
    createApplication({ root: import.meta.dirname, discover: false, providers: [MailServiceProvider, ...providers] }, { env: { LOG_LEVEL: 'silent', ...env } });

  it('Mailer.send() returns the message id of the transport MAIL_DRIVER names', async () => {
    const app = await boot([plugin('SesProvider', { ses })], { MAIL_DRIVER: 'ses' });
    const sent = await app.container.make(Mailer).send(new WelcomeMail('Ada'));
    expect(sent.messageId).toBe('ses-Welcome, Ada');
    expect(sent.subject).toBe('Welcome, Ada');
  });

  it('hands the factory its name, the container and a logger', async () => {
    let seen: Record<string, unknown> = {};
    const spy: MailDriverFactory = (context) => ((seen = { ...context }), { send: async () => ({ messageId: undefined }) });
    await boot([plugin('SpyProvider', { spy })], { MAIL_DRIVER: 'spy' });
    expect(seen.name).toBe('spy');
    expect(Object.keys(seen).sort()).toEqual(['container', 'logger', 'name']);
    expect(typeof (seen.logger as { info?: unknown }).info).toBe('function');
  });

  it('the built-in transports return no id: there is no provider', async () => {
    const app = await boot([], { MAIL_DRIVER: 'array' });
    expect((await app.container.make(Mailer).send(new WelcomeMail('Ada'))).messageId).toBeUndefined();
  });

  it('stops the start for a name nobody brought, and lists the known ones', async () => {
    const error = await boot([plugin('SesProvider', { ses })], { MAIL_DRIVER: 'nope' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[marmeon:Q8] MAIL_DRIVER=nope is not a mail driver. Known: log, array, smtp, ses.');
  });

  it('stops the start for a malformed name', async () => {
    await expect(boot([], { MAIL_DRIVER: 'No Way' })).rejects.toThrow(/MAIL_DRIVER/);
  });

  it('refuses a built-in name, and leaves no SMTP credentials in the message', async () => {
    const error = await boot([plugin('EvilProvider', { smtp: ses })], { MAIL_DRIVER: 'smtp', MAIL_PASSWORD: 'hunter2-secret' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('EvilProvider brings a mail driver named "smtp", but that name belongs to the built-in one');
    expect(String(error)).not.toContain('hunter2-secret');
    await expect(boot([plugin('LogProvider', { log: ses })], {})).rejects.toThrow(/belongs to the built-in one/);
  });

  it('refuses a name twice and a factory that returns no transport', async () => {
    await expect(boot([plugin('One', { ses }), plugin('Two', { ses })], { MAIL_DRIVER: 'ses' })).rejects.toThrow(/brought by both One and Two/);
    const broken = (() => ({})) as unknown as MailDriverFactory;
    await expect(boot([plugin('BrokenProvider', { broken })], { MAIL_DRIVER: 'broken' })).rejects.toThrow('[marmeon:Q8] The mail driver "broken" must return a MailTransport');
  });

  it('a transport that resolves with nothing has no message id — and the send still succeeds', async () => {
    const silent: MailDriverFactory = () => ({ send: (async () => undefined) as unknown as MailTransport['send'] });
    const app = await boot([plugin('SilentProvider', { silent })], { MAIL_DRIVER: 'silent' });
    expect((await app.container.make(Mailer).send(new WelcomeMail('Ada'))).messageId).toBeUndefined();
  });

  it('closes the transport at shutdown, when it has a close()', async () => {
    let closed = 0;
    const holding: MailDriverFactory = () => ({ send: async () => ({ messageId: undefined }), close: async () => void closed++ });
    const app = await boot([plugin('HoldingProvider', { holding })], { MAIL_DRIVER: 'holding' });
    await app.shutdown();
    expect(closed).toBe(1);
  });

  it('builds the transport at the start: a factory that throws stops it', async () => {
    const down: MailDriverFactory = () => {
      throw new Error('no credentials for the provider');
    };
    await expect(boot([plugin('DownProvider', { down })], { MAIL_DRIVER: 'down' })).rejects.toThrow('no credentials for the provider');
  });
});

describe('MailFake', () => {
  it('records mailables, composes them (a broken template fails), and asserts', async () => {
    const mail = new MailFake();
    mail.assertNothingSent();
    expect((await mail.send(new WelcomeMail('Ada'))).messageId).toMatch(/^<fake-\d+@marmeon\.test>$/);
    mail.assertSent(WelcomeMail).assertSent(WelcomeMail, (_mail, message) => message.to[0]!.address === 'ada@example.com').assertSentCount(WelcomeMail, 1);
    expect(() => mail.assertSent(WelcomeMail, (_mail, message) => message.subject === 'nope')).toThrow('Expected a WelcomeMail matching the filter to be sent. Sent: WelcomeMail to ada@example.com.');
    expect(() => mail.assertNothingSent()).toThrow('Expected no mail, sent WelcomeMail.');
    expect(mail.sent(WelcomeMail)[0]!.message.text).toContain('https://app.test/start');
    class Broken implements Mailable {
      envelope() {
        return { to: 'a@b.test', subject: 'x' };
      }
      content(): MailContent {
        throw new Error('template broke');
      }
    }
    await expect(mail.send(new Broken())).rejects.toThrow('template broke');
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

export function mailTypes() {
  // content() must be { html, text }: an element of some UI library is not (this package knows none).
  // @ts-expect-error — an object that is not { html: string; text: string }
  const element: Mailable = { envelope: () => ({ to: 'a@b.test', subject: 'x' }), content: () => ({ type: 'p', props: {}, key: null }) };
  // Templates are content too: the text version is derived.
  const fromTemplate: Mailable = { envelope: () => ({ to: 'a@b.test', subject: 'x' }), content: () => mjml`<mjml><mj-body></mj-body></mjml>` };
  // @ts-expect-error — a plain string is neither markup nor { html, text }
  const plain: Mailable = { envelope: () => ({ to: 'a@b.test', subject: 'x' }), content: () => '<p>x</p>' };
  expectTypeOf(fromHtml(html`<p>x</p>`)).toEqualTypeOf<MailContent>();
  void element;
  void fromTemplate;
  void plain;
}

/** A tiny SMTP server: answers every command with success and keeps what it was told. */
async function withSmtpServer(run: (port: number) => Promise<void>): Promise<{ envelope: string[]; data: string }> {
  const received = { envelope: [] as string[], data: '' };
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 test\r\n');
        else if (command === 'MAIL' || command === 'RCPT') {
          received.envelope.push(line.replace(/ SIZE=\d+/, ''));
          socket.write('250 ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'STAR') {
          // STARTTLS: this server has no TLS (or someone on the way stripped it).
          socket.write('454 TLS not available\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as { port: number }).port);
  } finally {
    // A client that gave up (no STARTTLS) may leave its connection open.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  return received;
}
