import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { devHosts } from '@marmeon/core/dev';

const DEFAULT_FROM_ADDRESS = 'hello@example.com';

export const MailConfig = defineConfig('mail', {
  env: env({
    /** `log` (default: written to the log, nothing is sent), `array` (kept in memory) or `smtp` (nodemailer, a dependency of this package). */
    MAIL_DRIVER: env.in(['log', 'array', 'smtp']).default('log'),
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
    NODE_ENV: env.string().optional(),
    APP_URL: env.string().optional(),
  }).renamed('MAIL_MAILER', 'MAIL_DRIVER'),
  resolve: (e) => {
    const address = e.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
    return {
      mailer: e.MAIL_DRIVER,
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
      /** The mail previews under `/_marmeon/mail`: only with `NODE_ENV=development`, never "not production". */
      previews: environment.isDevelopment(e),
      /** The hosts the previews answer (DNS rebinding): loopback names and `APP_URL`'s; any other gets 403. */
      previewHosts: devHosts(e.APP_URL),
      /** Protected (production, or no `NODE_ENV`): the boot warns about `MAIL_DRIVER=log` ({@link LOG_MAILER_WARNING}). */
      protected: environment.isProtected(e),
    };
  },
});
export type MailConfig = ConfigOf<typeof MailConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs on the
 * `log` mailer — the default when `MAIL_DRIVER` is not set.
 * The log mailer stays as it is everywhere: in development the links of a mail are clicked from the log.
 */
export const LOG_MAILER_WARNING =
  'MAIL_DRIVER=log outside development and tests: no mail is sent — every mail is written to the log instead, its links and tokens (password ' +
  'reset, e-mail verification, signed URLs) in plain text. Set MAIL_DRIVER=smtp and MAIL_HOST, ' +
  'MAIL_USERNAME, MAIL_PASSWORD.';

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) sends from the
 * default address because `MAIL_FROM_ADDRESS` is not set. Not an error: without SMTP the default does no harm.
 */
export const fromDefaultWarning = (mailer: string): string =>
  `MAIL_FROM_ADDRESS is not set: mail goes out from ${DEFAULT_FROM_ADDRESS}, which receiving servers reject or file as spam. ` +
  `Set it to an address of your domain.${mailer === 'log' ? ' (MAIL_DRIVER=log: now only in the log.)' : ''}`;
