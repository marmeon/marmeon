import { createApplication, Logger, type LogContext, type ServiceProviderClass } from '@marmeon/core';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { describe, expect, it } from 'vitest';
import { Mailer, MailServiceProvider, MailTransport, type Mailable, type MailDriverFactory } from '../index.ts';
import { POSTMARK_TEST_TOKEN_WARNING } from '../config.ts';
import { PostmarkTransport } from './postmark.ts';

const TOKEN = ['pm', 'server', 'token', '0123456789'].join('-');
const ENDPOINT = 'https://api.postmarkapp.com/email';

class Welcome implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'Welcome' };
  }
  content() {
    return { html: '<p>Hello</p>', text: 'Hello' };
  }
}

const plugin = (name: string, mailDrivers: Record<string, MailDriverFactory>): ServiceProviderClass => ({ [name]: class { static mailDrivers = mailDrivers; } })[name]!;
const boot = (env: Record<string, string>, providers: ServiceProviderClass[] = [FetchServiceProvider], http = new HttpClientFake()) =>
  createApplication(
    { root: import.meta.dirname, discover: false, providers: [MailServiceProvider, ...providers] },
    { env: { LOG_LEVEL: 'silent', MAIL_FROM_ADDRESS: 'team@app.test', ...env }, override: (container) => container.instance(HttpClient, http) },
  );

describe('MAIL_DRIVER=postmark', () => {
  it('builds the Postmark transport and sends through the app\'s HttpClient, with the message id of the answer', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, Response.json({ MessageID: 'id-42', ErrorCode: 0 }));
    const app = await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN }, [FetchServiceProvider], http);
    expect(app.container.make(MailTransport)).toBeInstanceOf(PostmarkTransport);
    const sent = await app.container.make(Mailer).send(new Welcome());
    expect(sent.messageId).toBe('id-42');
    http.assertSentCount(1);
    expect(http.requests[0]!.headers.get('x-postmark-server-token')).toBe(TOKEN);
  });

  it('stops the start without a token, and the message names the variable, not a value', async () => {
    const error = await boot({ MAIL_DRIVER: 'postmark' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[marmeon:Q8] MAIL_DRIVER=postmark needs MAIL_POSTMARK_TOKEN');
    const filled = await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: '' }).catch((caught: unknown) => caught);
    expect(String(filled)).toContain('needs MAIL_POSTMARK_TOKEN');
    // the request header is trimmed, so a token of whitespace is no token
    const blank = await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: ' \n' }).catch((caught: unknown) => caught);
    expect(String(blank)).toContain('[marmeon:Q8] MAIL_DRIVER=postmark needs MAIL_POSTMARK_TOKEN');
  });

  it('stops the start when the app has no HttpClient, and says marmeon discover', async () => {
    const app = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [MailServiceProvider] },
      { env: { LOG_LEVEL: 'silent', MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN } },
    ).catch((caught: unknown) => caught);
    expect(String(app)).toContain('[marmeon:Q8] MAIL_DRIVER=postmark sends through the HttpClient of @marmeon/fetch, which this app does not register. Run marmeon discover');
    expect(String(app)).not.toContain(TOKEN);
  });

  it('refuses an app\'s own driver named postmark: the name is built in', async () => {
    const mine: MailDriverFactory = () => ({ send: async () => ({ messageId: undefined }) });
    const error = await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN }, [FetchServiceProvider, plugin('MyProvider', { postmark: mine })]).catch((caught: unknown) => caught);
    expect(String(error)).toContain('MyProvider brings a mail driver named "postmark", but that name belongs to the built-in one');
    expect(String(error)).not.toContain(TOKEN);
  });

  it('lists postmark among the known drivers', async () => {
    const error = await boot({ MAIL_DRIVER: 'nope' }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('Known: log, array, smtp, postmark.');
  });

  it('says so when the transport is resolved before the mail provider booted, and does not send anyone to install a package', async () => {
    class Early {
      boot(app: { container: { make(token: typeof MailTransport): unknown } }) {
        app.container.make(MailTransport);
      }
    }
    const first = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [Early as unknown as ServiceProviderClass, MailServiceProvider, FetchServiceProvider] },
      { env: { LOG_LEVEL: 'silent', MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: TOKEN }, override: (container) => container.instance(HttpClient, new HttpClientFake()) },
    ).catch((caught: unknown) => caught);
    expect(String(first)).toContain('[marmeon:Q8] The mail transport was resolved before MailServiceProvider booted');
    expect(String(first)).not.toContain('marmeon add fetch');
    expect(String(first)).not.toContain(TOKEN);
  });
});

describe('Postmark\'s test token in a protected app', () => {
  const warningsWith = async (env: Record<string, string>) => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
    await createApplication(
      { root: import.meta.dirname, discover: false, providers: [MailServiceProvider, FetchServiceProvider] },
      { env: { LOG_LEVEL: 'silent', MAIL_FROM_ADDRESS: 'team@app.test', MAIL_DRIVER: 'postmark', ...env }, override: (container) => {
        container.instance(HttpClient, new HttpClientFake());
        container.instance(Logger, logger);
      } },
    );
    return warnings;
  };

  it('warns once at boot in production and with no NODE_ENV, and says that no mail is delivered', async () => {
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST' })).toEqual([POSTMARK_TEST_TOKEN_WARNING]);
    expect(await warningsWith({ NODE_ENV: '', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST' })).toEqual([POSTMARK_TEST_TOKEN_WARNING]);
    // what is sent is the trimmed value (a file-mounted secret ends in a newline)
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST ' })).toEqual([POSTMARK_TEST_TOKEN_WARNING]);
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST\n' })).toEqual([POSTMARK_TEST_TOKEN_WARNING]);
    expect(POSTMARK_TEST_TOKEN_WARNING).toContain('delivers none');
  });

  it('is quiet in development and tests, and for any other token', async () => {
    expect(await warningsWith({ NODE_ENV: 'test', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'development', MAIL_POSTMARK_TOKEN: 'POSTMARK_API_TEST' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'production', MAIL_POSTMARK_TOKEN: TOKEN })).toEqual([]);
  });
});
