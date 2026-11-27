import { createApplication } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { MailServiceProvider } from '../index.ts';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@marmeon/fetch', async (original) => {
  loads.count++;
  return original();
});

const boot = (env: Record<string, string>) =>
  createApplication({ root: import.meta.dirname, discover: false, providers: [MailServiceProvider] }, { env: { LOG_LEVEL: 'silent', ...env } });

describe('@marmeon/fetch is loaded for an API driver only', () => {
  it('MAIL_DRIVER=smtp, log and array never load it', async () => {
    for (const MAIL_DRIVER of ['smtp', 'log', 'array']) await boot({ MAIL_DRIVER });
    expect(loads.count).toBe(0);
  });

  it('MAIL_DRIVER=postmark loads it (the control that makes the count above mean something)', async () => {
    await boot({ MAIL_DRIVER: 'postmark', MAIL_POSTMARK_TOKEN: 'x' }).catch(() => undefined);
    expect(loads.count).toBe(1);
  });
});
