import { createApplication } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { MailServiceProvider } from '../index.ts';

// `importFetch` is the one place an API driver loads the package; a module mock fires once per registry, so each driver is counted here.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./api.ts', async (original) => {
  const module = await original<typeof import('./api.ts')>();
  return {
    ...module,
    importFetch: (load?: Parameters<typeof module.importFetch>[0]) => {
      loads.count++;
      return module.importFetch(load);
    },
  };
});

const boot = (env: Record<string, string>) =>
  createApplication({ root: import.meta.dirname, discover: false, providers: [MailServiceProvider] }, { env: { LOG_LEVEL: 'silent', ...env } });

describe('every API driver loads @marmeon/fetch at boot, and no other driver does', () => {
  it('counts one load for postmark, one for resend, none for the rest', async () => {
    for (const MAIL_DRIVER of ['smtp', 'log', 'array']) await boot({ MAIL_DRIVER });
    expect(loads.count).toBe(0);
    await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: 'x' }).catch(() => undefined);
    expect(loads.count).toBe(1);
    await boot({ MAIL_DRIVER: 'resend', MAIL_RESEND_API_KEY: 'x' }).catch(() => undefined);
    expect(loads.count).toBe(2);
  });
});
