import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { devHosts } from '@marmeon/core/dev';

export const MailConfig = defineConfig('mail', {
  env: env({
    /** `log` (default: written to the log, nothing is sent), `array` (kept in memory) or `smtp` (nodemailer, a dependency of this package). */
    MAIL_MAILER: env.in(['log', 'array', 'smtp']).default('log'),
    MAIL_FROM_ADDRESS: env.email('MAIL_FROM_ADDRESS must be an e-mail address').default('hello@example.com'),
    MAIL_FROM_NAME: env.string().default(''),
    MAIL_HOST: env.string().default('127.0.0.1'),
    MAIL_PORT: env.port().default(587),
    /** `true`: TLS from the first byte (port 465). Otherwise STARTTLS (required unless MAIL_REQUIRE_TLS=false). */
    MAIL_SECURE: env.in(['true', 'false']).default('false'),
    // Without MAIL_SECURE: STARTTLS or no mail — `false` only for a local server without TLS (Mailpit).
    MAIL_REQUIRE_TLS: env.in(['true', 'false']).default('true'),
    MAIL_USERNAME: env.string().default(''),
    MAIL_PASSWORD: env.string().default(''),
    NODE_ENV: env.string().optional(),
    APP_URL: env.string().optional(),
  }),
  resolve: (e) => ({
    mailer: e.MAIL_MAILER,
    from: e.MAIL_FROM_NAME ? { address: e.MAIL_FROM_ADDRESS, name: e.MAIL_FROM_NAME } : e.MAIL_FROM_ADDRESS,
    smtp: {
      host: e.MAIL_HOST,
      port: e.MAIL_PORT,
      secure: e.MAIL_SECURE === 'true',
      requireTls: e.MAIL_REQUIRE_TLS === 'true',
      username: e.MAIL_USERNAME,
      password: e.MAIL_PASSWORD,
    },
    /** The mail previews under `/_marmeon/mail`: only with `NODE_ENV=development`, never "not production". */
    previews: environment.isDevelopment(e),
    /** The hosts the previews answer (DNS rebinding): loopback names and `APP_URL`'s; any other gets 403. */
    previewHosts: devHosts(e.APP_URL),
    /** Protected (production, or no `NODE_ENV`): the boot warns about `MAIL_MAILER=log` ({@link LOG_MAILER_WARNING}). */
    protected: environment.isProtected(e),
  }),
});
export type MailConfig = ConfigOf<typeof MailConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs on the
 * `log` mailer — the default when `MAIL_MAILER` is not set.
 * The log mailer stays as it is everywhere: in development the links of a mail are clicked from the log.
 */
export const LOG_MAILER_WARNING =
  'MAIL_MAILER=log outside development and tests: no mail is sent — every mail is written to the log instead, its links and tokens (password ' +
  'reset, e-mail verification, signed URLs) in plain text. Set MAIL_MAILER=smtp and MAIL_HOST, ' +
  'MAIL_USERNAME, MAIL_PASSWORD.';
