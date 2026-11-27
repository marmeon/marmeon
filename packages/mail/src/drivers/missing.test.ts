import { createApplication } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { MailServiceProvider } from '../index.ts';

// The loader finds no @marmeon/fetch, as `importFetch` does for an ERR_MODULE_NOT_FOUND that names it (api.test.ts proves that mapping).
vi.mock('./api.ts', async (original) => ({ ...(await original<typeof import('./api.ts')>()), importFetch: async () => undefined }));

describe('MAIL_DRIVER=postmark without @marmeon/fetch installed', () => {
  it('stops the start and names the command that installs it, not the token', async () => {
    const error = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [MailServiceProvider] },
      { env: { LOG_LEVEL: 'silent', MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: ['pm', 'secret', 'token'].join('-') } },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toContain(
      '[marmeon:Q8] MAIL_DRIVER=postmark sends through @marmeon/fetch (marmeon add fetch; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/fetch@<version of your app>).',
    );
    expect(String(error)).not.toContain('pm-secret-token');
  });

  it('names the driver that was chosen: resend too', async () => {
    const key = ['re', 'secret', 'key'].join('_');
    const error = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [MailServiceProvider] },
      { env: { LOG_LEVEL: 'silent', MAIL_DRIVER: 'resend', MAIL_RESEND_API_KEY: key } },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toContain('[marmeon:Q8] MAIL_DRIVER=resend sends through @marmeon/fetch (marmeon add fetch;');
    expect(String(error)).not.toContain(key);
  });
});
