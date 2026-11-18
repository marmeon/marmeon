import { createApplication } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { ChatConfig, parseWebhooks } from './config.ts';
import { ChatSetupError } from './errors.ts';

const secret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slack = `https://hooks.slack.com/services/${secret}`;
const teams = `https://prod-1.westeurope.environment.api.powerplatform.com/powerautomate/automations/direct/${secret}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers&sig=a=b`;

function refusal(entries: string[]): ChatSetupError {
  try {
    parseWebhooks(entries);
  } catch (error) {
    expect(error).toBeInstanceOf(ChatSetupError);
    return error as ChatSetupError;
  }
  throw new Error('expected a refusal');
}

describe('parseWebhooks', () => {
  it('reads name=address entries and keeps a "=" inside the address', () => {
    const webhooks = parseWebhooks([`ops=${slack}`, `alerts-2=${teams}`]);
    expect([...webhooks.keys()]).toEqual(['ops', 'alerts-2']);
    expect(webhooks.get('ops')).toBe(slack);
    expect(webhooks.get('alerts-2')).toBe(teams);
  });

  it('lists no destination for an empty list', () => {
    expect(parseWebhooks([]).size).toBe(0);
  });

  it('refuses a malformed entry by its position, without its value', () => {
    const error = refusal([`ops=${slack}`, slack, `alerts=${slack}`]);
    expect(error.message).toBe(
      '[marmeon:S10] CHAT_WEBHOOKS: entry 2 is not name=https://… — a name of lowercase letters, digits and dashes, "=", then the address; entries are split at commas.',
    );
    expect(error.message).not.toContain(secret);
  });

  it('refuses an empty entry, a missing address and a name that is not a name', () => {
    expect(refusal(['ops=']).message).toContain('entry 1 is not name=');
    expect(refusal(['=https://x.example/y']).message).toContain('entry 1 is not name=');
    expect(refusal([`Ops=${slack}`]).message).toContain('entry 1 is not name=');
    expect(refusal([`1ops=${slack}`]).message).toContain('entry 1 is not name=');
    expect(refusal([`ops=${slack}`, '']).message).toContain('entry 2 is not name=');
  });

  it('refuses a name that is listed twice, naming the name and no address', () => {
    const error = refusal([`ops=${slack}`, `alerts=${slack}`, `ops=${teams}`]);
    expect(error.message).toBe('[marmeon:S10] CHAT_WEBHOOKS: the name "ops" is listed twice.');
  });

  it('lets a name that is also an Object.prototype key stand as a name', () => {
    const webhooks = parseWebhooks([`constructor=${slack}`]);
    expect(webhooks.get('constructor')).toBe(slack);
    expect(webhooks.get('toString')).toBeUndefined();
  });
});

describe('ChatConfig', () => {
  const load = async (env: Record<string, string>) => (await createApplication({ root: import.meta.dirname, discover: false, providers: [class { static config = [ChatConfig]; }] }, { env: { LOG_LEVEL: 'silent', ...env } })).container.make(ChatConfig);

  it('defaults to the log sink with no destination', async () => {
    expect(await load({ NODE_ENV: 'test' })).toMatchObject({ driver: 'log', webhooks: [], protected: false });
  });

  it('splits the entries at commas, trims them and protects every environment but development and test', async () => {
    expect(await load({ CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: ` ops=${slack} , alerts=${teams}`, NODE_ENV: 'production' })).toMatchObject({
      driver: 'slack',
      webhooks: [`ops=${slack}`, `alerts=${teams}`],
      protected: true,
    });
    expect((await load({})).protected).toBe(true);
  });

  it('refuses a driver name that is not a name', async () => {
    const error = (await load({ CHAT_DRIVER: 'Slack' }).then(() => undefined, (caught: unknown) => caught)) as Error;
    expect(error.message).toBe(
      '[marmeon:K6] Invalid configuration — the application cannot start:\n  • chat: CHAT_DRIVER — must be a driver name: lowercase letters, digits and dashes\nSet or rename these variables in the environment or in .env (see .env.example).',
    );
  });
});
