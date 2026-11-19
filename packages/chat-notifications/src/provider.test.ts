import { Application, Clock, createApplication, Logger, Redactor, type LogContext, type ServiceProviderClass } from '@marmeon/core';
import { Encrypter, EncryptionServiceProvider } from '@marmeon/encryption';
import { HttpClient, FetchServiceProvider } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { JobRegistry, Queue, QueueServiceProvider } from '@marmeon/queue';
import { TestClock } from '@marmeon/core/testing';
import { QueueFake } from '@marmeon/queue/testing';
import { describe, expect, it } from 'vitest';
import { CHAT_LOG_WARNING } from './config.ts';
import type { ChatDriverContext, ChatDriverFactory } from './driver.ts';
import { ChatDeliveryError, ChatError, ChatSetupError } from './errors.ts';
import { SendQueuedChatMessage } from './job.ts';
import { ChatNotifier } from './notifier.ts';
import { ChatServiceProvider, importQueue, WEBHOOK_PATTERNS } from './provider.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
// webhook addresses are joined at run time
const slackSecret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slackUrl = ['https://hooks.slack.com/services', slackSecret].join('/');
const discordSecret = ['1234567890', 'd'.repeat(40)].join('/');
const discordUrl = ['https://discord.com/api/webhooks', discordSecret].join('/');
const teamsSecret = ['workflow-0', 'triggers/manual/paths/invoke'].join('/');
const teamsUrl = `https://prod-12.westeurope.environment.api.powerplatform.com/powerautomate/automations/direct/${teamsSecret}?sig=${'q'.repeat(30)}`;
const mattermostUrl = 'https://chat.example.com/hooks/abc123';

const plugin = (name: string, chatDrivers: Record<string, ChatDriverFactory> | undefined): ServiceProviderClass =>
  ({ [name]: class { static chatDrivers = chatDrivers; } })[name]!;

const mattermost: ChatDriverFactory = () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (content) => ({ json: { text: content.text } }) });
const custom = (name: string, driver: unknown): ServiceProviderClass => plugin('BrokenProvider', { [name]: (() => driver) as ChatDriverFactory });

interface Boot {
  env?: Record<string, string>;
  providers?: ServiceProviderClass[];
  http?: HttpClientFake;
  logger?: Logger;
  withFetch?: boolean;
}

function boot({ env = {}, providers = [], http = new HttpClientFake(), logger, withFetch = true }: Boot = {}): Promise<Application> {
  return createApplication(
    { root: import.meta.dirname, discover: false, providers: [...(withFetch ? [FetchServiceProvider] : []), ChatServiceProvider, ...providers] },
    {
      env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', ...env },
      override: (container) => {
        if (withFetch) container.instance(HttpClient, http);
        if (logger) container.instance(Logger, logger);
      },
    },
  );
}

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

describe('ChatServiceProvider: the start', () => {
  it('stops without the HttpClient, and says where it comes from', async () => {
    const error = await rejection(boot({ withFetch: false }));
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message).toBe('[marmeon:S10] Chat messages need the FetchServiceProvider of @marmeon/fetch (installed with this package: marmeon discover).');
  });

  it('stops for a CHAT_DRIVER nobody brought, and lists the known drivers', async () => {
    expect((await rejection(boot({ env: { CHAT_DRIVER: 'nope' } }))).message).toBe('[marmeon:S10] CHAT_DRIVER=nope is not a chat driver. Known: log, slack, discord, teams.');
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'nope' }, providers: [plugin('MattermostProvider', { mattermost })] }));
    expect(error.message).toBe('[marmeon:S10] CHAT_DRIVER=nope is not a chat driver. Known: log, slack, discord, teams, mattermost.');
  });

  it('stops for a malformed CHAT_WEBHOOKS entry (by position) and a name listed twice', async () => {
    expect((await rejection(boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl},${slackUrl}` } }))).message).toBe(
      '[marmeon:S10] CHAT_WEBHOOKS: entry 2 is not name=https://… — a name of lowercase letters, digits and dashes, starting with a letter, "=", then the address; entries are split at commas.',
    );
    expect((await rejection(boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl},ops=${slackUrl}` } }))).message).toBe('[marmeon:S10] CHAT_WEBHOOKS: the name "ops" is listed twice.');
  });

  it('stops for an address the selected driver does not accept, and names the destination and the host but not the address', async () => {
    const evil = `https://hooks.slack.com.evil.example/services/${slackSecret}`;
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `alerts=${slackUrl},ops=${evil}` } }));
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message).toBe(
      '[marmeon:S10] CHAT_WEBHOOKS: the destination "ops" is refused for CHAT_DRIVER=slack: The webhook host "hooks.slack.com.evil.example" is not one of the hosts of driver "slack" (hooks.slack.com).',
    );
    expect(error.message).not.toContain(slackSecret);
    expect((await rejection(boot({ env: { CHAT_DRIVER: 'discord', CHAT_WEBHOOKS: `ops=${slackUrl}` } }))).message).toContain('the destination "ops" is refused for CHAT_DRIVER=discord');
    expect((await rejection(boot({ env: { CHAT_DRIVER: 'teams', CHAT_WEBHOOKS: `ops=http://prod.environment.api.powerplatform.com/powerautomate/automations/direct/x` } }))).message).toContain('must be written as https://host/path');
  });

  it('accepts addresses of the selected driver, and takes any address under the log sink', async () => {
    await boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` } });
    await boot({ env: { CHAT_DRIVER: 'discord', CHAT_WEBHOOKS: `ops=${discordUrl}` } });
    await boot({ env: { CHAT_DRIVER: 'teams', CHAT_WEBHOOKS: `ops=${teamsUrl}` } });
    await boot({ env: { CHAT_DRIVER: 'log', CHAT_WEBHOOKS: `ops=${slackUrl},dev=${mattermostUrl}` } });
  });
});

describe('ChatServiceProvider: custom drivers', () => {
  const mm = { CHAT_DRIVER: 'mattermost', CHAT_WEBHOOKS: `ops=${mattermostUrl}` };

  it('uses the driver a provider brings under that name, hands its factory the name, the container and a logger of the chat channel, and builds it once', async () => {
    const seen: ChatDriverContext[] = [];
    const bindings: LogContext[] = [];
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: (context: LogContext) => (bindings.push(context), logger) };
    const factory: ChatDriverFactory = (context) => (seen.push(context), mattermost(context));
    const http = new HttpClientFake().respond(mattermostUrl, new Response(null, { status: 200 }));
    const app = await boot({ env: mm, providers: [plugin('MattermostProvider', { mattermost: factory })], http, logger });
    await app.container.make(ChatNotifier).send({ to: 'ops', text: 'Deploy done' });
    await app.container.make(ChatNotifier).send({ to: 'ops', text: 'Again' });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(['container', 'logger', 'name']);
    expect(seen[0]?.name).toBe('mattermost');
    expect(bindings).toContainEqual({ channel: 'chat' });
    expect(http.requests.map((request) => request.url)).toEqual([mattermostUrl, mattermostUrl]);
    expect(await http.requests[0]?.clone().json()).toEqual({ text: 'Deploy done' });
  });

  it('refuses an address on another host than the custom driver lists, in the worker too', async () => {
    const http = new HttpClientFake();
    const app = await boot({ env: { CHAT_DRIVER: 'mattermost' }, providers: [plugin('MattermostProvider', { mattermost })], http });
    const error = await rejection(app.container.make(ChatNotifier).send({ to: { url: 'https://evil.example/hooks/abc123' }, text: 'x' }));
    expect(error).toBeInstanceOf(ChatDeliveryError);
    expect(error).toMatchObject({ reason: 'refused' });
    http.assertNothingSent();
  });

  it('lets a destination name a custom driver that CHAT_DRIVER does not select, and builds it then', async () => {
    const http = new HttpClientFake().respond(/./, new Response(null, { status: 200 }));
    const app = await boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` }, providers: [plugin('MattermostProvider', { mattermost })], http });
    await app.container.make(ChatNotifier).send({ to: { url: mattermostUrl, driver: 'mattermost' }, text: 'Hi' });
    expect(http.requests).toHaveLength(1);
    expect(app.container.make(ChatNotifier).check({ url: mattermostUrl, driver: 'mattermost' })).toBeUndefined();
  });

  const broken: [string, unknown, string][] = [
    ['an object with no render()', { hosts: ['chat.example.com'], paths: ['/hooks/'] }, 'it has no render(content, raw) function'],
    ['no object', 'driver', 'it returned no object'],
    ['null', null, 'it returned no object'],
    ['no hosts', { hosts: [], paths: ['/hooks/'], render() {} }, '`hosts` must be a non-empty list of host names such as "chat.example.com" or "*.example.com"'],
    ['hosts that are no list', { hosts: 'chat.example.com', paths: ['/hooks/'], render() {} }, '`hosts` must be a non-empty list'],
    ['a host of "*"', { hosts: ['*'], paths: ['/hooks/'], render() {} }, '`hosts[0]` is refused: A host pattern is a lower-case DNS name'],
    ['a host that is an IP address', { hosts: ['chat.example.com', '10.0.0.1'], paths: ['/hooks/'], render() {} }, '`hosts[1]` is refused'],
    ['a host with a port', { hosts: ['chat.example.com:8443'], paths: ['/hooks/'], render() {} }, '`hosts[0]` is refused'],
    ['a host that is no string', { hosts: [1], paths: ['/hooks/'], render() {} }, '`hosts` must be a non-empty list of host names'],
    ['no paths', { hosts: ['chat.example.com'], paths: [], render() {} }, '`paths` must be a non-empty list of path prefixes such as "/hooks/"'],
    ['a path without its slashes', { hosts: ['chat.example.com'], paths: ['hooks'], render() {} }, '`paths[0]` is refused'],
    ['the path "/"', { hosts: ['chat.example.com'], paths: ['/'], render() {} }, '`paths[0]` is refused'],
    ['a path with a dot segment', { hosts: ['chat.example.com'], paths: ['/hooks/../'], render() {} }, '`paths[0]` is refused'],
  ];

  it.each(broken)('stops the start for a selected driver with %s, naming the driver', async (_name, driver, problem) => {
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'mm' }, providers: [custom('mm', driver)] }));
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message.startsWith('[marmeon:S10] The chat driver "mm" must return a ChatDriver: ')).toBe(true);
    expect(error.message).toContain(problem);
    expect(error.message).not.toMatch(/[^.]\.\.$/);
  });

  it('pins one full message of a driver that breaks its contract', async () => {
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'mm' }, providers: [custom('mm', { hosts: ['chat.example.com'], paths: ['/hooks/'] })] }));
    expect(error.message).toBe('[marmeon:S10] The chat driver "mm" must return a ChatDriver: it has no render(content, raw) function.');
    const refused = await rejection(boot({ env: { CHAT_DRIVER: 'mm' }, providers: [custom('mm', { hosts: ['*'], paths: ['/hooks/'], render() {} })] }));
    expect(refused.message).toBe('[marmeon:S10] The chat driver "mm" must return a ChatDriver: `hosts[0]` is refused: A host pattern is a lower-case DNS name of at least two labels, or `*.` and such a name.');
  });

  it('treats a driver whose hosts getter throws like a driver that breaks its contract: check() answers every time, the start stops with S10', async () => {
    let calls = 0;
    const factory: ChatDriverFactory = () => {
      calls += 1;
      return {
        get hosts(): string[] {
          throw new Error(`secret ${slackUrl}`);
        },
        paths: ['/hooks/'],
        render: () => ({ json: {} }),
      };
    };
    const app = await boot({ env: { CHAT_DRIVER: 'slack' }, providers: [plugin('BrokenProvider', { mm: factory })] });
    const chat = app.container.make(ChatNotifier);
    const message = 'The chat driver "mm" must return a ChatDriver: reading it failed.';
    expect(chat.check({ url: mattermostUrl, driver: 'mm' })).toBe(message);
    expect(chat.check({ url: mattermostUrl, driver: 'mm' })).toBe(message);
    expect(calls).toBe(2);
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'mm' }, providers: [plugin('BrokenProvider', { mm: factory })] }));
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message).toBe(`[marmeon:S10] ${message}`);
    expect(error).not.toHaveProperty('cause');
  });

  it('stops the start when the factory of the selected driver throws, keeping its error as the cause', async () => {
    const cause = new Error('no config');
    const factory: ChatDriverFactory = () => {
      throw cause;
    };
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'mm' }, providers: [plugin('BrokenProvider', { mm: factory })] }));
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message).toBe('[marmeon:S10] The chat driver "mm" could not be built.');
    expect(error.cause).toBe(cause);
  });

  it('checks the addresses of CHAT_WEBHOOKS against the custom driver it selects', async () => {
    const error = await rejection(boot({ env: { CHAT_DRIVER: 'mattermost', CHAT_WEBHOOKS: `ops=https://evil.example/hooks/abc123` }, providers: [plugin('MattermostProvider', { mattermost })] }));
    expect(error.message).toBe('[marmeon:S10] CHAT_WEBHOOKS: the destination "ops" is refused for CHAT_DRIVER=mattermost: The webhook host "evil.example" is not one of the hosts of driver "mattermost" (chat.example.com).');
    await boot({ env: mm, providers: [plugin('MattermostProvider', { mattermost })] });
  });

  it('fails the use, not the start, of a driver that CHAT_DRIVER does not select and that breaks its contract', async () => {
    const app = await boot({ env: { CHAT_DRIVER: 'slack' }, providers: [custom('mm', { hosts: ['*'], paths: ['/'], render() {} })] });
    const error = await rejection(app.container.make(ChatNotifier).send({ to: { url: mattermostUrl, driver: 'mm' }, text: 'x' }));
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toContain('The chat driver "mm" must return a ChatDriver');
  });

  it('stops the start for a name of a built-in driver, with the TypeError of the framework', async () => {
    for (const name of ['slack', 'discord', 'teams', 'log']) {
      const error = await rejection(boot({ providers: [plugin('ClashProvider', { [name]: mattermost })] }));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain(`brings a chat driver named "${name}", but that name belongs to the built-in one. Built-in names: log, slack, discord, teams.`);
    }
  });

  it('stops the start for a name two providers bring', async () => {
    const error = await rejection(boot({ providers: [plugin('OneProvider', { mattermost }), plugin('TwoProvider', { mattermost })] }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain('The chat driver "mattermost" is brought by both OneProvider and TwoProvider');
  });
});

describe('ChatServiceProvider: the redactor', () => {
  it('masks the address of a Slack, Discord or Teams webhook in a text, and the values of its keys', async () => {
    const app = await boot();
    const redactor = app.container.make(Redactor);
    for (const url of [slackUrl, discordUrl, teamsUrl, `https://discordapp.com/api/v10/webhooks/${discordSecret}`, `https://canary.discord.com/api/webhooks/${discordSecret}`]) {
      const text = redactor.text(`request to ${url} failed`);
      expect(text, url).toContain('request to ');
      expect(text, url).toContain(' failed');
      for (const secret of [slackSecret, discordSecret, teamsSecret, 'q'.repeat(30)]) expect(text, `${url} ${secret}`).not.toContain(secret);
    }
    // the forms the guard accepts: any case, a trailing dot, port 443
    for (const url of [
      `HTTPS://HOOKS.SLACK.COM/services/${slackSecret}`,
      `https://hooks.slack.com:443/services/${slackSecret}`,
      `https://hooks.slack.com./services/${slackSecret}`,
      `https://discord.com:443/api/webhooks/${discordSecret}`,
      `https://Discord.com/api/webhooks/${discordSecret}`,
      teamsUrl.replace('.environment.api.powerplatform.com', '.ENVIRONMENT.API.POWERPLATFORM.COM'),
      teamsUrl.replace('.com/', '.com:443/'),
      teamsUrl.replace('.com/', '.com./'),
    ]) {
      const text = redactor.text(`request to ${url} failed`);
      for (const secret of [slackSecret, discordSecret, teamsSecret, 'q'.repeat(30)]) expect(text, `${url} ${secret}`).not.toContain(secret);
    }
    for (const key of ['webhook', 'webhooks', 'webhook_url', 'webhookUrl', 'chat_webhooks', 'CHAT_WEBHOOKS']) expect(redactor.isSensitive(key), key).toBe(true);
  });
});

describe('ChatServiceProvider: the redactor patterns stay linear', () => {
  it('have no bounded run and start on a literal', () => {
    for (const pattern of WEBHOOK_PATTERNS) {
      expect(pattern.source, String(pattern)).not.toMatch(/\{\d+(?:,\d*)?\}/);
      expect(pattern.source.startsWith('https:') || pattern.source.startsWith(String.raw`\.environment`), String(pattern)).toBe(true);
    }
  });

  it('pass a long text of dotted labels much faster than the pattern that backtracked', () => {
    const text = 'ab.'.repeat(90_000);
    const reference = /[\w.-]{1,253}\.environment\.api\.powerplatform\.com[^\s"'<>]*/g;
    const shipped = WEBHOOK_PATTERNS[2]!;
    const best = (pattern: RegExp): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 2; run += 1) {
        const copy = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        const start = performance.now();
        copy.test(text);
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const slow = best(reference);
    // a reference under a millisecond means the machine or the text is wrong: fail loudly, never pass vacuously
    expect(slow).toBeGreaterThan(1);
    expect(best(shipped) * 20).toBeLessThan(slow);
  });

  it('keep the text of a long dotted run whole', async () => {
    const app = await boot();
    const text = 'ab.'.repeat(6000);
    expect(app.container.make(Redactor).text(text)).toBe(text);
  });

  it('masks the path and the query of a Teams address and keeps its host', async () => {
    const app = await boot();
    expect(app.container.make(Redactor).text(`to ${teamsUrl} failed`)).toBe('to https://prod-12.westeurope[redacted] failed');
  });
});

describe('ChatServiceProvider: the warning', () => {
  const warningsWith = async (env: Record<string, string>): Promise<string[]> => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {}, child: () => logger };
    await boot({ env, logger });
    return warnings;
  };

  it('warns once at boot when a protected environment runs on the log sink', async () => {
    expect(await warningsWith({ NODE_ENV: 'production' })).toEqual([CHAT_LOG_WARNING]);
    expect(await warningsWith({ NODE_ENV: 'production', CHAT_DRIVER: 'log' })).toEqual([CHAT_LOG_WARNING]);
    expect(await warningsWith({ NODE_ENV: '' })).toEqual([CHAT_LOG_WARNING]);
    expect(CHAT_LOG_WARNING).toBe(
      "CHAT_DRIVER=log outside development and tests: no chat message is sent — only each message's destination and title are written to the log. Set CHAT_DRIVER=slack, discord or teams and CHAT_WEBHOOKS.",
    );
  });

  it('stays quiet in development and tests, and with a real driver', async () => {
    expect(await warningsWith({ NODE_ENV: 'test' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'development' })).toEqual([]);
    expect(await warningsWith({ NODE_ENV: 'production', CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` })).toEqual([]);
  });
});

describe('ChatServiceProvider: the notifier', () => {
  it('posts to a named destination through the HttpClient of the container', async () => {
    const http = new HttpClientFake().respond(slackUrl, new Response('ok'));
    const app = await boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` }, http });
    await app.container.make(ChatNotifier).send({ to: 'ops', title: 'Release', text: 'Deploy done' });
    http.assertSentCount(1);
  });

  it('sends nothing by default: the log sink', async () => {
    const http = new HttpClientFake();
    const app = await boot({ env: { CHAT_WEBHOOKS: `ops=${slackUrl}` }, http });
    await app.container.make(ChatNotifier).send({ to: 'ops', text: 'Deploy done' });
    await app.container.make(ChatNotifier).send({ to: { url: slackUrl, driver: 'slack' }, text: 'Deploy done' });
    http.assertNothingSent();
  });

  it('check() says why an address is refused, and nothing for one that is fine', async () => {
    const app = await boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` } });
    const chat = app.container.make(ChatNotifier);
    expect(chat.check('ops')).toBeUndefined();
    expect(chat.check({ url: slackUrl })).toBeUndefined();
    expect(chat.check({ url: `https://hooks.slack.com.evil.example/services/${slackSecret}` })).toBe('The webhook host "hooks.slack.com.evil.example" is not one of the hosts of driver "slack" (hooks.slack.com).');
    expect(chat.check('alerts')).toBe('No destination "alerts" — CHAT_WEBHOOKS names ops.');
    expect(chat.check({ url: slackUrl, driver: 'nope' })).toBe('The chat driver "nope" is not known. Known: slack, discord, teams.');
    expect(chat.check({ url: 'x'.repeat(5000) })).toContain('"to.url" must be a string of 1 to 2000 characters');
    expect(chat.check(42 as never)).toContain('"to" must be a destination name');
    expect(chat.check({ url: slackUrl, driver: 'slack', extra: 1 } as never)).toBeUndefined();
  });
});

describe('ChatServiceProvider: the queue', () => {
  const queued = async (env: Record<string, string> = {}, http = new HttpClientFake(), extra: ServiceProviderClass[] = []) => {
    const app = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, EncryptionServiceProvider, QueueServiceProvider, ChatServiceProvider, ...extra] },
      {
        env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', APP_KEY: KEY, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}`, ...env },
        override: (container) => {
          container.instance(HttpClient, http);
          container.instance(Queue, new QueueFake(container));
        },
      },
    );
    return { app, http, queue: app.container.make(Queue) as QueueFake, chat: app.container.make(ChatNotifier) };
  };

  it('registers the framework job marmeon.chat', async () => {
    const { app } = await queued();
    expect(app.container.make(JobRegistry).get('marmeon.chat')).toBe(SendQueuedChatMessage);
  });

  it('queues an encrypted job whose payload holds neither the address nor the text', async () => {
    const { http, queue, chat } = await queued();
    http.respond(/./, new Response('ok'));
    await chat.queue({ to: { url: discordUrl, driver: 'discord' }, text: 'secret words', links: [{ label: 'Open', url: 'https://app.example/r' }] }, { queue: 'chat', delay: 30 });
    await chat.queue({ to: 'ops', text: 'for ops' }, { delay: 30 });
    const [first] = queue.dispatched(SendQueuedChatMessage);
    expect(first).toMatchObject({ queue: 'chat', delaySeconds: 30, payload: { to: { url: discordUrl, driver: 'discord' }, content: { text: 'secret words' } } });
    const stored = queue.pending().map((entry) => entry.payload).join('\n');
    expect(stored).toContain('"job":"marmeon.chat"');
    expect(stored).not.toContain(discordSecret);
    expect(stored).not.toContain('discord.com');
    expect(stored).not.toContain('secret words');
    http.assertNothingSent();
    expect(await queue.work()).toMatchObject({ processed: 0 });
  });

  it('binds the ciphertext to the job name: the payload of marmeon.chat does not decrypt as the payload of another job', async () => {
    const { app, queue, chat } = await queued();
    await chat.queue({ to: { url: discordUrl, driver: 'discord' }, text: 'secret words' }, { delay: 30 });
    const record = JSON.parse(queue.pending()[0]!.payload) as { job: string; v: number; encrypted?: boolean; data: string };
    expect(record).toMatchObject({ job: 'marmeon.chat', encrypted: true });
    const encrypter = app.container.make(Encrypter);
    expect(await encrypter.decrypt(record.data, `queue:v${record.v}:marmeon.chat`)).toContain('secret words');
    await expect(encrypter.decrypt(record.data, `queue:v${record.v}:marmeon.mail`)).rejects.toThrow();
    await expect(encrypter.decrypt(record.data, `queue:v${record.v}:marmeon.notification`)).rejects.toThrow();
  });

  it('does the work in the worker: a queued message is checked again and posted with the driver of the worker', async () => {
    const { http, queue, chat } = await queued();
    http.respond(/./, new Response('ok'));
    await chat.queue({ to: 'ops', text: 'for ops' });
    await chat.queue({ to: { url: discordUrl, driver: 'discord' }, text: 'for the customer' });
    expect(await queue.work()).toMatchObject({ processed: 2, failed: 0 });
    expect(http.requests.map((request) => new URL(request.url).host)).toEqual(['hooks.slack.com', 'discord.com']);
  });

  it('refuses at the call what would fail in the worker: an address, a name, a driver, a bad raw format and a raw key no driver has', async () => {
    const { http, queue, chat } = await queued();
    const refused = (message: Parameters<ChatNotifier['queue']>[0]) => rejection(chat.queue(message));
    expect((await refused({ to: { url: `https://hooks.slack.com.evil.example/services/${slackSecret}` }, text: 'x' })).message).toBe(
      'The chat message to a webhook on hooks.slack.com.evil.example is refused: The webhook host "hooks.slack.com.evil.example" is not one of the hosts of driver "slack" (hooks.slack.com).',
    );
    expect((await refused({ to: 'alerts', text: 'x' })).message).toBe('The chat message to destination "alerts" is refused: No destination "alerts" — CHAT_WEBHOOKS names ops.');
    expect((await refused({ to: { url: slackUrl, driver: 'nope' }, text: 'x' })).message).toContain('The chat driver "nope" is not known.');
    expect((await refused({ to: 'ops', text: 'x', raw: { slack: { blocks: 'x' } } as never })).message).toBe('Chat message: "raw.slack.blocks" must be a list.');
    expect((await refused({ to: 'ops', text: 'x', raw: { teems: { card: {} } } as never })).message).toBe('Chat message: "raw.teems" names no chat driver. Known: slack, discord, teams.');
    expect((await refused({ to: 'ops', text: '' })).message).toContain('"text" must not be empty');
    expect(queue.dispatched(SendQueuedChatMessage)).toEqual([]);
    http.assertNothingSent();
  });

  it('refuses a raw format of the driver of the destination, not of a driver the message is not for', async () => {
    const { queue, chat } = await queued();
    await chat.queue({ to: 'ops', text: 'x', raw: { teams: { card: 'nonsense' } } as never });
    expect(queue.dispatched(SendQueuedChatMessage)).toHaveLength(1);
    await expect(chat.queue({ to: { url: teamsUrl, driver: 'teams' }, text: 'x', raw: { teams: { card: 'nonsense' } } as never })).rejects.toThrow('"raw.teams.card"');
  });

  it('validates a raw format when it posts now, too, before any request', async () => {
    const { http, chat } = await queued();
    http.respond(/./, new Response('ok'));
    await expect(chat.send({ to: 'ops', text: 'x', raw: { slack: { blocks: 'x' } } as never })).rejects.toThrow('"raw.slack.blocks" must be a list');
    await expect(chat.send({ to: 'ops', text: 'x', raw: { nope: {} } as never })).rejects.toThrow('"raw.nope" names no chat driver');
    http.assertNothingSent();
  });

  it('under the log sink the worker logs a queued message and sends nothing', async () => {
    const { http, queue, chat } = await queued({ CHAT_DRIVER: 'log' });
    await chat.queue({ to: { url: slackUrl, driver: 'slack' }, text: 'x' });
    expect(await queue.work()).toMatchObject({ processed: 1, failed: 0 });
    http.assertNothingSent();
  });

  it('keeps the keys of raw that a record schema drops: constructor and __proto__ reach the driver as send() hands them', async () => {
    const seen: unknown[] = [];
    const factory: ChatDriverFactory = () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (_content, raw) => (seen.push(raw), { json: {} }) });
    const { queue, chat, http } = await queued({ CHAT_DRIVER: 'constructor', CHAT_WEBHOOKS: `ops=${mattermostUrl}` }, undefined, [plugin('RawProvider', Object.fromEntries([['constructor', factory]]))]);
    http.respond(/./, new Response('ok'));
    const raw = { constructor: { a: 1, nested: Object.fromEntries([['constructor', 2], ['__proto__', 3], ['prototype', 4]]) } };
    await chat.send({ to: 'ops', text: 'x', raw: raw as never });
    await chat.queue({ to: 'ops', text: 'x', raw: raw as never });
    expect(await queue.work()).toMatchObject({ processed: 1, failed: 0 });
    // send(): the dry render and the post; queue(): the dry render; the worker: the dry render and the post
    expect(seen).toHaveLength(5);
    for (const each of seen) expect(each).toEqual(seen[0]);
    expect(Object.keys((seen.at(-1) as { nested: object }).nested).sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });

  it('passes queue, connection and delay on to the dispatch', async () => {
    const { queue, chat } = await queued();
    await chat.queue({ to: 'ops', text: 'x' }, { queue: 'chat', connection: 'sync', delay: 30 });
    expect(queue.dispatched(SendQueuedChatMessage)[0]).toMatchObject({ queue: 'chat', connection: 'sync', delaySeconds: 30 });
  });

  it('retries a refused post after 10 s, 1 min, 5 min and 5 min, and fails the job on the fifth try', async () => {
    const http = new HttpClientFake().respond(/./, () => new Response('bad gateway', { status: 502 }));
    const app = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, EncryptionServiceProvider, QueueServiceProvider, ChatServiceProvider] },
      {
        env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', APP_KEY: KEY, QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` },
        override: (container) => {
          container.instance(Clock, new TestClock());
          container.instance(HttpClient, http);
          container.instance(Queue, new QueueFake(container));
        },
      },
    );
    const queue = app.container.make(Queue) as QueueFake;
    const clock = app.container.make(Clock) as TestClock;
    await app.container.make(ChatNotifier).queue({ to: 'ops', text: 'x' });
    clock.freeze(); // 299 s must still be "not due yet": a running clock could pass the second in between
    for (const wait of [0, 10, 60, 300]) {
      clock.travel({ seconds: wait });
      expect(await queue.work()).toMatchObject({ released: 1, failed: 0 });
    }
    clock.travel({ seconds: 299 });
    expect(await queue.work()).toMatchObject({ processed: 0 });
    clock.travel({ seconds: 1 });
    expect(await queue.work()).toMatchObject({ released: 0, failed: 1 });
    expect(http.requests).toHaveLength(5);
    expect(queue.pending()).toEqual([]);
  });

  it('says what is missing without the QueueServiceProvider, and registers no job', async () => {
    const app = await boot({ env: { CHAT_DRIVER: 'slack', CHAT_WEBHOOKS: `ops=${slackUrl}` } });
    expect(app.container.has(JobRegistry)).toBe(false);
    const error = await rejection(app.container.make(ChatNotifier).queue({ to: 'ops', text: 'x' }));
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toBe('chat.queue() needs @marmeon/queue (marmeon add queue; or pnpm add -E @marmeon/queue@<version of your app> and marmeon discover) — or post now: chat.send().');
  });
});

describe('importQueue', () => {
  const error = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

  it('is undefined when @marmeon/queue is not installed', async () => {
    expect(await importQueue(() => Promise.reject(error("Cannot find package '@marmeon/queue' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
  });

  it('rethrows any other import error, also a missing package that is another one', async () => {
    await expect(importQueue(() => Promise.reject(error('boom while loading')))).rejects.toThrow('boom while loading');
    await expect(importQueue(() => Promise.reject(error("Cannot find package 'something-else' imported from x", 'ERR_MODULE_NOT_FOUND')))).rejects.toThrow('something-else');
    await expect(importQueue(() => Promise.reject(error("mentions @marmeon/queue but has no code")))).rejects.toThrow('has no code');
    // the importer's path names the package, the missing one is another
    await expect(
      importQueue(() => Promise.reject(error("Cannot find package 'missing-dependency' imported from /app/node_modules/@marmeon/queue/dist/provider.js", 'ERR_MODULE_NOT_FOUND'))),
    ).rejects.toThrow('missing-dependency');
    expect(await importQueue(() => Promise.reject(error("Cannot find module '@marmeon/queue' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
  });
});
