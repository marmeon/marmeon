import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { devHosts } from '@marmeon/core/dev';

const DEFAULT_FROM_ADDRESS = 'hello@example.com';

/** The built-in transports; a provider can bring more (`static mailDrivers`). */
export const BUILT_IN_MAIL_DRIVERS = ['log', 'array', 'smtp', 'postmark'] as const;

/** The built-in transports that send through the `HttpClient` of @marmeon/fetch: their start needs that package and a credential. */
export const API_MAIL_DRIVERS: readonly string[] = ['postmark'];

export const MailConfig = defineConfig('mail', {
  env: env({
    /**
     * `log` (default: written to the log, nothing is sent), `array` (kept in memory), `smtp` (nodemailer, a dependency of this package),
     * `postmark` (the Postmark API, through @marmeon/fetch) or a transport a provider brings. A name nobody brought stops the start.
     */
    MAIL_DRIVER: env.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a driver name: lowercase letters, digits and dashes').default('log'),
    MAIL_FROM_ADDRESS: env.email('MAIL_FROM_ADDRESS must be an e-mail address').optional(),
    MAIL_FROM_NAME: env.string().default(''),
    MAIL_HOST: env.string().default('127.0.0.1'),
    MAIL_PORT: env.port().default(587),
    /** `true`: TLS from the first byte (port 465). Otherwise STARTTLS (required unless MAIL_REQUIRE_TLS=false). */
    MAIL_SECURE: env.boolean().default(false),
    // Without MAIL_SECURE: STARTTLS or no mail — `false` only for a local server without TLS (Mailpit).
    MAIL_REQUIRE_TLS: env.boolean().default(true),
    MAIL_USERNAME: env.string().default(''),
    MAIL_PASSWORD: env.string().default(''),
    /** The Postmark server API token; `MAIL_DRIVER=postmark` stops the start without it. The name ends in `TOKEN`, so the log redactor masks it. */
    MAIL_POSTMARK_TOKEN: env.string().default(''),
    NODE_ENV: env.string().optional(),
    APP_URL: env.string().optional(),
  }).renamed('MAIL_MAILER', 'MAIL_DRIVER'),
  resolve: (e) => {
    const address = e.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
    return {
      driver: e.MAIL_DRIVER,
      from: e.MAIL_FROM_NAME ? { address, name: e.MAIL_FROM_NAME } : address,
      /** `MAIL_FROM_ADDRESS` is not set: the boot of a protected environment warns ({@link fromDefaultWarning}). */
      fromDefaulted: e.MAIL_FROM_ADDRESS === undefined,
      smtp: {
        host: e.MAIL_HOST,
        port: e.MAIL_PORT,
        secure: e.MAIL_SECURE,
        requireTls: e.MAIL_REQUIRE_TLS,
        username: e.MAIL_USERNAME,
        password: e.MAIL_PASSWORD,
      },
      postmark: { token: e.MAIL_POSTMARK_TOKEN },
      /** The mail previews under `/_marmeon/mail`: only with `NODE_ENV=development`, never "not production". */
      previews: environment.isDevelopment(e),
      /** The hosts the previews answer (DNS rebinding): loopback names and `APP_URL`'s; any other gets 403. */
      previewHosts: devHosts(e.APP_URL),
      /** Protected (production, or no `NODE_ENV`): the boot warns about `MAIL_DRIVER=log` ({@link LOG_MAILER_WARNING}) and about Postmark's test token ({@link POSTMARK_TEST_TOKEN_WARNING}). */
      protected: environment.isProtected(e),
    };
  },
});
export type MailConfig = ConfigOf<typeof MailConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs on the
 * `log` mailer — the default when `MAIL_DRIVER` is not set.
 * The log mailer writes the text of a mail only in development and tests, where its links are clicked from the log.
 */
export const LOG_MAILER_WARNING =
  "MAIL_DRIVER=log outside development and tests: no mail is sent — only each mail's recipients and subject are written to the log, its text is " +
  'left out. Set MAIL_DRIVER=smtp and MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD, or MAIL_DRIVER=postmark and MAIL_POSTMARK_TOKEN.';

/** The token Postmark documents for tests: its API accepts every request and delivers none. */
export const POSTMARK_TEST_TOKEN = 'POSTMARK_API_TEST';

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs `MAIL_DRIVER=postmark` with
 * Postmark's test token: every mail is accepted and none is delivered.
 */
export const POSTMARK_TEST_TOKEN_WARNING =
  `MAIL_DRIVER=postmark with MAIL_POSTMARK_TOKEN=${POSTMARK_TEST_TOKEN} outside development and tests: Postmark accepts every mail and delivers none. ` +
  'Set the server API token of your Postmark server.';

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) sends from the
 * default address because `MAIL_FROM_ADDRESS` is not set. Not an error: without SMTP the default does no harm.
 */
export const fromDefaultWarning = (driver: string): string =>
  `MAIL_FROM_ADDRESS is not set: mail goes out from ${DEFAULT_FROM_ADDRESS}, which receiving servers reject or file as spam. ` +
  `Set it to an address of your domain.${driver === 'log' ? ' (MAIL_DRIVER=log: no mail is sent.)' : ''}`;
