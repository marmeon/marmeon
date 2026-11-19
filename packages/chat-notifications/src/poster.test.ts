import { inspect } from 'node:util';
import type { Logger } from '@marmeon/core';
import { HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { describe, expect, it } from 'vitest';
import type { ChatDriver, ChatDriverFactory } from './driver.ts';
import { ChatDeliveryError, ChatError } from './errors.ts';
import { normalizeMessage, type ChatContent, type ChatDestination, type ChatMessage } from './message.ts';
import { ChatPoster, retryAfterSeconds } from './poster.ts';
import { ChatTargets } from './targets.ts';

// webhook addresses are joined at run time: no address-shaped literal in the source
const slackSecret = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slackUrl = ['https://hooks.slack.com/services', slackSecret].join('/');
const discordSecret = ['1234567890', 'd'.repeat(40)].join('/');
const discordUrl = ['https://discord.com/api/webhooks', discordSecret].join('/');
const teamsSecret = ['workflow-0', 'triggers/manual/paths/invoke'].join('/');
const teamsQuery = ['api-version=1', 'sp=%2Ftriggers%2Fmanual%2Frun', 'sig=', 'q'.repeat(30)].join('&').replace('&sig=&', '&sig=');
const teamsUrl = `https://prod-12.westeurope.environment.api.powerplatform.com:443/powerautomate/automations/direct/${teamsSecret}?${teamsQuery}`;
const secrets = [slackSecret, discordSecret, teamsSecret, 'q'.repeat(30)];

interface Entry {
  level: string;
  message: string;
  context: unknown;
}

function logger(entries: Entry[]): Logger {
  const log = (level: string) => (message: string, context?: unknown) => void entries.push({ level, message, context });
  const instance: Logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: () => instance };
  return instance;
}

interface Options {
  driver?: string;
  webhooks?: Record<string, string>;
  custom?: Record<string, ChatDriverFactory>;
  protected?: boolean;
  now?: number;
  /** A client of its own instead of the fake. */
  client?: HttpClient;
}

function setup(options: Options = {}) {
  const http = new HttpClientFake();
  const entries: Entry[] = [];
  const targets = new ChatTargets({
    driver: options.driver ?? 'slack',
    webhooks: new Map(Object.entries(options.webhooks ?? {})),
    custom: () => new Map(Object.entries(options.custom ?? {})),
    context: (name) => ({ name, container: undefined as never, logger: logger(entries) }),
  });
  const poster = new ChatPoster({ targets, http: () => options.client ?? http, logger: logger(entries), clock: { now: () => options.now ?? 0 }, protected: options.protected ?? false });
  const deliver = (to: ChatDestination, message: Partial<ChatMessage> = {}, signal?: AbortSignal): Promise<void> => {
    const { content } = normalizeMessage({ text: 'Deploy done', ...message, to });
    return poster.deliver(to, content, signal);
  };
  return { http, entries, targets, poster, deliver };
}

const reply = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body === '' ? null : body, { status, headers });

async function failure(promise: Promise<unknown>): Promise<ChatDeliveryError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ChatDeliveryError);
  return error as ChatDeliveryError;
}

/** Everything an error shows: its message, its cause, its JSON and what `inspect` prints (stack and cause chain included). */
const shown = (error: Error): string => [error.message, String(error.cause), JSON.stringify(error), inspect(error, { depth: 6 })].join('\n');

describe('ChatPoster: one request per driver', () => {
  it('posts the Slack message to the address with the JSON body, no redirects, and a limit on time and answer', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(slackUrl, reply(200, 'ok'));
    await deliver('ops', { title: 'Release', text: 'Deploy done' });
    http.assertSentCount(1);
    const [request] = http.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(slackUrl);
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('accept')).toBe('application/json, text/plain');
    expect(await request?.clone().json()).toMatchObject({ text: 'Release\nDeploy done', blocks: [{ type: 'header' }, { type: 'section' }] });
  });

  it('posts Discord with no query unless the message has links, and with_components=true when it has', async () => {
    const { http, deliver } = setup({ driver: 'discord', webhooks: { ops: discordUrl } });
    http.respond(/./, reply(204));
    await deliver('ops');
    await deliver('ops', { links: [{ label: 'Open', url: 'https://app.example/runs/1' }] });
    expect(http.requests.map((request) => request.url)).toEqual([discordUrl, `${discordUrl}?with_components=true`]);
    expect(await http.requests[0]?.clone().json()).toMatchObject({ allowed_mentions: { parse: [] }, embeds: [{ description: 'Deploy done' }] });
  });

  it('adds the query of the driver to an address that has one of its own, and keeps the rest', async () => {
    const { http, deliver } = setup({ driver: 'discord' });
    http.respond(/./, reply(204));
    await deliver({ url: `${discordUrl}?thread_id=42`, driver: 'discord' }, { links: [{ label: 'Open', url: 'https://app.example/r' }] });
    expect(new URL(http.requests[0]!.url).searchParams.get('thread_id')).toBe('42');
    expect(new URL(http.requests[0]!.url).searchParams.get('with_components')).toBe('true');
  });

  it('posts Teams to the address as it was written, its query included (no default port in the URL)', async () => {
    const { http, deliver } = setup({ driver: 'teams', webhooks: { ops: teamsUrl } });
    http.respond(/./, reply(202));
    await deliver('ops');
    const sent = new URL(http.requests[0]!.url);
    expect(sent.origin).toBe('https://prod-12.westeurope.environment.api.powerplatform.com');
    expect(sent.pathname).toBe(`/powerautomate/automations/direct/${teamsSecret}`);
    expect(sent.search).toBe(`?${teamsQuery}`);
    expect(await http.requests[0]?.clone().json()).toMatchObject({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive' }] });
  });

  it('uses the driver a destination names instead of CHAT_DRIVER', async () => {
    const { http, deliver } = setup({ driver: 'slack' });
    http.respond(/./, reply(204));
    await deliver({ url: discordUrl, driver: 'discord' });
    expect(await http.requests[0]?.clone().json()).toMatchObject({ embeds: expect.any(Array) });
  });

  it('passes the signal of the job on: an aborted one ends the request as unavailable', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(200));
    const controller = new AbortController();
    controller.abort();
    const error = await failure(deliver('ops', {}, controller.signal));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toContain('was aborted');
  });
});

describe('ChatPoster: what a webhook answers', () => {
  const answer = async (response: Response, options: Options = {}) => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl }, ...options });
    http.respond(/./, response);
    return failure(deliver('ops'));
  };

  it('is throttled for 429 and takes the seconds of Retry-After: delta seconds, decimals rounded up, an HTTP date', async () => {
    expect(await answer(reply(429, 'rate_limited', { 'retry-after': '7' }))).toMatchObject({ reason: 'throttled', status: 429, retryAfterSeconds: 7, providerCode: 'rate_limited' });
    expect(await answer(reply(429, '', { 'retry-after': '1.2' }))).toMatchObject({ reason: 'throttled', retryAfterSeconds: 2 });
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    const date = new Date(now + 30_000).toUTCString();
    expect(await answer(reply(429, '', { 'retry-after': date }), { now })).toMatchObject({ reason: 'throttled', retryAfterSeconds: 30 });
    const error = await answer(reply(429));
    expect(error.reason).toBe('throttled');
    expect(error).not.toHaveProperty('retryAfterSeconds');
  });

  it('is gone for 404 and 410, and says the webhook is not tried again', async () => {
    for (const status of [404, 410]) {
      const error = await answer(reply(status, 'no_service'));
      expect(error).toMatchObject({ reason: 'gone', status, providerCode: 'no_service', permanent: true });
      expect(error.message).toBe(`The chat message to destination "ops" was not delivered: slack answered ${status} (no_service). The webhook was deleted or disabled; it is not tried again.`);
    }
  });

  it('is rejected for 400 and names the provider code', async () => {
    const error = await answer(reply(400, 'invalid_payload'));
    expect(error).toMatchObject({ reason: 'rejected', status: 400, providerCode: 'invalid_payload', permanent: true });
    expect(error.message).toBe('The chat message to destination "ops" was not delivered: slack answered 400 (invalid_payload).');
  });

  it('is unavailable for 408, 425 and 5xx, and honours Retry-After of a 503 only', async () => {
    for (const status of [408, 425, 500, 502, 504]) expect(await answer(reply(status, '', { 'retry-after': '9' }))).toMatchObject({ reason: 'unavailable', status, permanent: false });
    expect(await answer(reply(500, '', { 'retry-after': '9' }))).not.toHaveProperty('retryAfterSeconds');
    expect(await answer(reply(503, '', { 'retry-after': '9' }))).toMatchObject({ reason: 'unavailable', retryAfterSeconds: 9 });
  });

  it('is unavailable when the network fails, and keeps no cause', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(200)).failNext('network');
    const error = await failure(deliver('ops'));
    expect(error.reason).toBe('unavailable');
    expect(error).not.toHaveProperty('cause');
  });

  it('is unavailable for a timeout, and refused when the HTTP client refuses the request', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(200)).failNext('timeout').failNext('refused');
    expect(await failure(deliver('ops'))).toMatchObject({ reason: 'unavailable' });
    expect(await failure(deliver('ops'))).toMatchObject({ reason: 'refused', permanent: true });
  });

  it('is rejected for a redirect, and sends exactly one request', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(slackUrl, reply(302, '', { location: 'https://evil.example/collect' }));
    http.respond('https://evil.example/collect', reply(200));
    expect(await failure(deliver('ops'))).toMatchObject({ reason: 'rejected' });
    http.assertSentCount(1);
  });

  it('is rejected for any other status, also an unexpected 2xx-looking 3xx', async () => {
    expect(await answer(reply(403, 'invalid_token'))).toMatchObject({ reason: 'rejected', status: 403 });
    expect(await answer(reply(300))).toMatchObject({ reason: 'rejected' });
  });

  it('accepts every 2xx', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    for (const status of [200, 201, 202, 204]) {
      http.respond(/./, reply(status, status === 204 ? '' : 'ok'));
      await deliver('ops');
    }
    http.assertSentCount(4);
  });
});

describe('ChatPoster: the provider code', () => {
  const code = async (driver: string, url: string, body: string): Promise<string | undefined> => {
    const { http, deliver } = setup({ driver, webhooks: { ops: url } });
    http.respond(/./, reply(400, body));
    return (await failure(deliver('ops'))).providerCode;
  };

  it('is the word of a Slack answer, and nothing else', async () => {
    expect(await code('slack', slackUrl, 'channel_not_found\n')).toBe('channel_not_found');
    for (const body of ['Invalid payload!', 'a'.repeat(65), `<html>${slackUrl}</html>`, 'two words', 'CAPS', '']) expect(await code('slack', slackUrl, body), body).toBeUndefined();
  });

  it('is the integer `code` of a Discord answer, and nothing else', async () => {
    expect(await code('discord', discordUrl, '{"message":"Unknown Webhook","code":10015}')).toBe('10015');
    for (const body of ['{"code":"10015"}', '{"code":1.5}', '{"code":-1}', '{"code":1e400}', '[1]', 'null', 'not json', `{"code":"${discordUrl}"}`]) expect(await code('discord', discordUrl, body), body).toBeUndefined();
  });

  it('is the short `error.code` of a Teams answer, and nothing else', async () => {
    expect(await code('teams', teamsUrl, '{"error":{"code":"InvalidRequest","message":"x"}}')).toBe('InvalidRequest');
    expect(await code('teams', teamsUrl, '{"error":{"code":"Flow.Not_Found"}}')).toBe('Flow.Not_Found');
    for (const body of ['{"error":{"code":"has space"}}', `{"error":{"code":"${'a'.repeat(65)}"}}`, '{"error":"InvalidRequest"}', '{"code":"InvalidRequest"}', `{"error":{"code":"${teamsUrl}"}}`]) {
      expect(await code('teams', teamsUrl, body), body).toBeUndefined();
    }
  });

  it('is left out for a driver that has no short form', async () => {
    const mattermost: ChatDriverFactory = () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (content) => ({ json: { text: content.text } }) });
    const { http, deliver } = setup({ driver: 'mattermost', custom: { mattermost }, webhooks: { ops: 'https://chat.example.com/hooks/abc' } });
    http.respond(/./, reply(400, 'invalid_payload'));
    expect(await failure(deliver('ops'))).not.toHaveProperty('providerCode');
  });
});

describe('retryAfterSeconds', () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);

  it('clamps to 1 to 3600 seconds and rounds decimals up', () => {
    expect(retryAfterSeconds('0', now)).toBe(1);
    expect(retryAfterSeconds('0.2', now)).toBe(1);
    expect(retryAfterSeconds('2.01', now)).toBe(3);
    expect(retryAfterSeconds('3600', now)).toBe(3600);
    expect(retryAfterSeconds('3601', now)).toBe(3600);
    expect(retryAfterSeconds('99999999999999999999999', now)).toBe(3600);
    expect(retryAfterSeconds(new Date(now - 60_000).toUTCString(), now)).toBe(1);
    expect(retryAfterSeconds(new Date(now + 86_400_000).toUTCString(), now)).toBe(3600);
  });

  it('is undefined for a header that is absent, or neither seconds nor an HTTP date', () => {
    for (const value of [null, '', 'soon', '-5', '1e3', '1,2', 'Thu 7', '7 days', '2026-11-18T12:00:30Z', 'Wed, 18 Nov 2026 12:00:30 PST']) expect(retryAfterSeconds(value, now), String(value)).toBeUndefined();
  });
});

describe('ChatPoster: the guard runs in the poster, every time', () => {
  const refused = async (to: ChatDestination, options: Options = {}) => {
    const { http, deliver } = setup(options);
    http.respond(/./, reply(200));
    const error = await failure(deliver(to));
    http.assertNothingSent();
    return error;
  };

  it('refuses an address on a host that only starts like the provider host', async () => {
    expect(await refused({ url: `https://hooks.slack.com.evil.example/services/${slackSecret}` })).toMatchObject({ reason: 'refused', permanent: true });
    expect(await refused({ url: `https://evilhooks.slack.com.example/services/${slackSecret}`, driver: 'slack' })).toMatchObject({ reason: 'refused' });
  });

  it('refuses http, an IP address, credentials and a port', async () => {
    for (const url of [
      `http://hooks.slack.com/services/${slackSecret}`,
      `https://127.0.0.1/services/${slackSecret}`,
      `https://169.254.169.254/services/${slackSecret}`,
      `https://user:pass@hooks.slack.com/services/${slackSecret}`,
      `https://hooks.slack.com:8443/services/${slackSecret}`,
      `https://hooks.slack.com/other/${slackSecret}`,
    ]) {
      expect(await refused({ url }), url).toMatchObject({ reason: 'refused' });
    }
  });

  it('refuses a named destination whose address the selected driver does not accept', async () => {
    expect(await refused('ops', { webhooks: { ops: `https://evil.example/services/${slackSecret}` } })).toMatchObject({ reason: 'refused' });
  });

  it('refuses an address that belongs to another driver than the one that formats for it', async () => {
    expect(await refused({ url: discordUrl, driver: 'slack' })).toMatchObject({ reason: 'refused' });
    expect(await refused({ url: slackUrl, driver: 'teams' })).toMatchObject({ reason: 'refused' });
  });

  it('names the host in a refusal and never the secret of the address', async () => {
    const error = await refused({ url: `https://hooks.slack.com.evil.example/services/${slackSecret}?token=${'q'.repeat(30)}` });
    expect(error.message).toContain('hooks.slack.com.evil.example');
    for (const secret of secrets) expect(shown(error)).not.toContain(secret);
  });
});

describe('ChatPoster: a destination or a driver that does not exist', () => {
  it('is a ChatError for a name CHAT_WEBHOOKS does not list, and says which it lists', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl, alerts: slackUrl } });
    http.respond(/./, reply(200));
    await expect(deliver('nope')).rejects.toThrow('No destination "nope" — CHAT_WEBHOOKS names ops, alerts.');
    await expect(setup().deliver('nope')).rejects.toThrow('No destination "nope" — CHAT_WEBHOOKS names none.');
    http.assertNothingSent();
  });

  it('is a ChatError, with no fallback to CHAT_DRIVER, for a driver nobody brought', async () => {
    const { http, deliver } = setup({ driver: 'slack' });
    http.respond(/./, reply(200));
    for (const driver of ['nope', 'log', 'constructor']) {
      const error = await deliver({ url: slackUrl, driver }).catch((caught: unknown) => caught);
      expect(error, driver).toBeInstanceOf(ChatError);
      expect(error, driver).not.toBeInstanceOf(ChatDeliveryError);
      expect((error as Error).message).toBe(`The chat driver "${driver}" is not known. Known: slack, discord, teams.`);
    }
    http.assertNothingSent();
  });

  it('looks drivers up in a Map: a name of Object.prototype is no driver, even when it gets past the name check', () => {
    const { targets } = setup();
    for (const name of ['toString', '__proto__', 'hasOwnProperty']) expect(() => targets.driver(name), name).toThrow('The chat driver is not known. Known: slack, discord, teams.');
  });

  it('is a ChatError for a driver nobody brought also under CHAT_DRIVER=log', async () => {
    const { http, deliver, entries } = setup({ driver: 'log' });
    await expect(deliver({ url: slackUrl, driver: 'nope' })).rejects.toThrow(ChatError);
    http.assertNothingSent();
    expect(entries).toEqual([]);
  });
});

describe('ChatPoster: CHAT_DRIVER=log sends nothing', () => {
  it('logs where a named destination goes and its text in development and tests, and sends nothing', async () => {
    const { http, deliver, entries } = setup({ driver: 'log', webhooks: { ops: slackUrl } });
    await deliver('ops', { title: 'Release', text: 'Deploy done', fields: [{ label: 'Env', value: 'prod' }] });
    http.assertNothingSent();
    expect(entries).toEqual([
      {
        level: 'info',
        message: 'Chat message to destination "ops" (CHAT_DRIVER=log: not sent)',
        context: { destination: 'destination "ops"', title: 'Release', text: 'Deploy done', fields: [{ label: 'Env', value: 'prod' }] },
      },
    ]);
  });

  it('logs no text and no fields in a protected environment, only the destination and the title', async () => {
    const { http, deliver, entries } = setup({ driver: 'log', webhooks: { ops: slackUrl }, protected: true });
    await deliver('ops', { title: 'Release', text: 'secret text', fields: [{ label: 'Env', value: 'secret value' }] });
    http.assertNothingSent();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toEqual({ destination: 'destination "ops"', title: 'Release' });
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('sends nothing for an address that names a driver of its own, and logs only its host', async () => {
    const { http, deliver, entries } = setup({ driver: 'log' });
    http.respond(/./, reply(200));
    await deliver({ url: slackUrl, driver: 'slack' });
    await deliver({ url: discordUrl, driver: 'discord' });
    await deliver({ url: teamsUrl, driver: 'teams' });
    http.assertNothingSent();
    expect(entries.map((entry) => entry.context)).toEqual([
      expect.objectContaining({ destination: 'a webhook on hooks.slack.com' }),
      expect.objectContaining({ destination: 'a webhook on discord.com' }),
      expect.objectContaining({ destination: 'a webhook on prod-12.westeurope.environment.api.powerplatform.com' }),
    ]);
    for (const secret of secrets) expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('checks an address that names a driver with the rule of that driver, then logs', async () => {
    const { http, deliver, entries } = setup({ driver: 'log' });
    http.respond(/./, reply(200));
    expect(await failure(deliver({ url: `https://hooks.slack.com.evil.example/services/${slackSecret}`, driver: 'slack' }))).toMatchObject({ reason: 'refused' });
    expect(await failure(deliver({ url: discordUrl, driver: 'slack' }))).toMatchObject({ reason: 'refused' });
    http.assertNothingSent();
    expect(entries).toEqual([]);
  });

  it('checks an address with no driver of its own with the basic rule: https, no credentials, no port, no IP address', async () => {
    const { http, deliver, entries } = setup({ driver: 'log', webhooks: { ops: `http://chat.example.com/hooks/${slackSecret}` } });
    for (const to of [
      { url: `http://chat.example.com/hooks/${slackSecret}` },
      { url: `https://127.0.0.1/hooks/${slackSecret}` },
      { url: `https://user:pw@chat.example.com/hooks/${slackSecret}` },
      { url: `https://chat.example.com:8443/hooks/${slackSecret}` },
      'ops',
    ] as const) {
      expect(await failure(deliver(to)), JSON.stringify(to)).toMatchObject({ reason: 'refused' });
    }
    await deliver({ url: `https://chat.example.com/hooks/${slackSecret}` });
    http.assertNothingSent();
    expect(entries).toHaveLength(1);
  });
});

describe('ChatPoster: what a driver renders is checked again', () => {
  const driverWith = (render: ChatDriver['render']): Options => ({ driver: 'mm', custom: { mm: () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render }) }, webhooks: { ops: 'https://chat.example.com/hooks/abc' } });

  it('posts the request of a custom driver on its own host', async () => {
    const { http, deliver } = setup(driverWith((content) => ({ json: { text: content.text, gone: undefined as never }, search: { channel: 'ops' } })));
    http.respond(/./, reply(200));
    await deliver('ops');
    expect(http.requests[0]?.url).toBe('https://chat.example.com/hooks/abc?channel=ops');
    expect(await http.requests[0]?.clone().json()).toEqual({ text: 'Deploy done' });
  });

  it('refuses what is not JSON, before any request', async () => {
    const bad: Record<string, ChatDriver['render']> = {
      date: () => ({ json: { at: new Date() } as never }),
      fn: () => ({ json: { f: () => 1 } as never }),
      infinity: () => ({ json: { n: Number.POSITIVE_INFINITY } }),
      instance: () => ({ json: new (class Box { x = 1; })() as never }),
      getter: () => ({ json: Object.defineProperty({}, 'x', { get: () => 1, enumerable: true }) as never }),
      nothing: () => ({}) as never,
      nobody: () => undefined as never,
      search: () => ({ json: {}, search: { a: 1 } as never }),
      searchList: () => ({ json: {}, search: ['a'] as never }),
      throws: () => {
        throw new TypeError('boom');
      },
    };
    for (const [name, render] of Object.entries(bad)) {
      const { http, deliver } = setup(driverWith(render));
      http.respond(/./, reply(200));
      const error = await deliver('ops').catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(ChatError);
      expect(error, name).not.toBeInstanceOf(ChatDeliveryError);
      http.assertNothingSent();
    }
  });

  it('is a ChatError, with no foreign cause, when the request of a driver cannot be read', async () => {
    const getter = (read: () => unknown) => ({ get json(): never { return read() as never; }, search: undefined });
    for (const render of [() => getter(() => { throw new Error(`boom ${slackUrl}`); }), () => ({ json: {}, get search(): never { throw new Error('boom'); } })]) {
      const { http, deliver } = setup(driverWith(render as never));
      http.respond(/./, reply(200));
      const error = (await deliver('ops').then(() => undefined, (caught: unknown) => caught)) as ChatError;
      expect(error).toBeInstanceOf(ChatError);
      expect(error.message).toBe('The chat driver "mm" returned a request that could not be read.');
      expect(error).not.toHaveProperty('cause');
      http.assertNothingSent();
    }
  });

  it('keeps the error of a driver that throws as the cause, and a ChatError of its own as it is', async () => {
    const own = new ChatError('Chat message: "raw.mm" must be an object.');
    const thrown = setup(driverWith(() => { throw own; }));
    await expect(thrown.deliver('ops')).rejects.toBe(own);
    const broken = setup(driverWith(() => { throw new RangeError('x'); }));
    const error = (await broken.deliver('ops').then(() => undefined, (caught: unknown) => caught)) as ChatError;
    expect(error.message).toBe('The chat driver "mm" failed to render the message.');
    expect(error.cause).toBeInstanceOf(RangeError);
  });

  it('hands a driver its own raw format, and an own key only (constructor is a name)', async () => {
    const seen: unknown[] = [];
    const { http, deliver } = setup({
      ...driverWith((_content, raw) => {
        seen.push(raw);
        return { json: { ok: true } };
      }),
      driver: 'constructor',
      custom: Object.fromEntries([['constructor', (() => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (_content: ChatContent, raw: unknown) => (seen.push(raw), { json: {} }) })) satisfies ChatDriverFactory]]),
    });
    http.respond(/./, reply(200));
    await deliver('ops');
    await deliver('ops', { raw: { constructor: { a: 1 } } as never });
    await deliver('ops', { raw: { slack: { blocks: [] } } });
    expect(seen).toEqual([undefined, { a: 1 }, undefined]);
  });

  it('keeps the hosts and paths a driver had when it was checked: a list changed afterwards widens nothing', async () => {
    const hosts = ['chat.example.com'];
    const paths = ['/hooks/'];
    const { http, deliver } = setup({
      driver: 'mm',
      custom: { mm: () => ({ hosts, paths, render: () => ({ json: {} }) }) },
      webhooks: { ops: 'https://chat.example.com/hooks/abc' },
    });
    http.respond(/./, reply(200));
    await deliver('ops');
    hosts.push('evil.example');
    paths.push('/anything/');
    expect(await failure(deliver({ url: 'https://evil.example/hooks/abc' }))).toMatchObject({ reason: 'refused' });
    expect(await failure(deliver({ url: 'https://chat.example.com/anything/abc' }))).toMatchObject({ reason: 'refused' });
    http.assertSentCount(1);
  });
});

describe('ChatPoster: the limits of a request', () => {
  it('posts with a time limit, a limit on the answer and no redirects', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(200));
    const seen: unknown[] = [];
    const fetch = http.fetch.bind(http);
    http.fetch = (input, options) => (seen.push(options), fetch(input, options));
    await deliver('ops');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', timeout: 10, maxResponseBytes: 16384, redirect: 'error' });
  });

  it('cancels the body of a 2xx answer', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    const events: string[] = [];
    http.respond(/./, () => new Response(new ReadableStream({ pull: (controller) => (events.push('read'), controller.enqueue(new Uint8Array([1]))), cancel: () => void events.push('cancel') }), { status: 200 }));
    await deliver('ops');
    expect(events).toContain('cancel');
  });
});

describe('ChatPoster: what a driver returns has a size', () => {
  const driverReturning = (json: () => unknown): Options => ({
    driver: 'mm',
    custom: { mm: () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: () => ({ json: json() as never }) }) },
    webhooks: { ops: 'https://chat.example.com/hooks/abc' },
  });
  const nested = (levels: number): unknown => (levels === 0 ? 1 : { a: nested(levels - 1) });

  it.each([
    ['more values than a request may hold', () => Array.from({ length: 20_001 }, () => 0), 'The request of the chat driver "mm" holds more than 20000 values.'],
    ['more bytes than a request may hold', () => ({ text: 'x'.repeat(129 * 1024) }), 'The request of the chat driver "mm" is larger than 128 KB as JSON.'],
    ['more levels than a request may nest', () => nested(65), 'The request of the chat driver "mm" is nested deeper than 64 levels.'],
    ['a value that is not JSON', () => ({ at: () => 1 }), 'The request of the chat driver "mm" holds a value that is not JSON (function).'],
  ])('refuses %s, before any request', async (_name, json, message) => {
    const { http, deliver } = setup(driverReturning(json));
    http.respond(/./, reply(200));
    const error = await deliver('ops').then(() => undefined, (caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(ChatError);
    expect(error?.message).toBe(message);
    http.assertNothingSent();
  });
});

describe('ChatPoster: a driver that cannot be built', () => {
  it('is built once: a factory that throws is called once and gives the same error again', async () => {
    let calls = 0;
    const { deliver, http } = setup({
      driver: 'slack',
      custom: { mm: () => { calls += 1; throw new Error('no config'); } },
    });
    http.respond(/./, reply(200));
    const first = await deliver({ url: 'https://chat.example.com/hooks/abc', driver: 'mm' }).then(() => undefined, (caught: unknown) => caught);
    const second = await deliver({ url: 'https://chat.example.com/hooks/abc', driver: 'mm' }).then(() => undefined, (caught: unknown) => caught);
    expect(calls).toBe(1);
    expect(first).toBeInstanceOf(ChatError);
    expect(second).toBe(first);
    expect((first as Error).message).toBe('The chat driver "mm" could not be built.');
  });
});

describe('ChatPoster: the lists of a driver are read once', () => {
  it('guards with the lists it checked: a getter that answers differently the second time widens nothing', async () => {
    let reads = 0;
    const driver = {
      get hosts() {
        reads += 1;
        return reads === 1 ? ['chat.example.com'] : ['com', '*.com'];
      },
      get paths() {
        return ['/hooks/'];
      },
      render: () => ({ json: {} }),
    };
    const { http, deliver } = setup({ driver: 'mm', custom: { mm: () => driver }, webhooks: { ops: 'https://chat.example.com/hooks/abc' } });
    http.respond(/./, reply(200));
    await deliver('ops');
    expect(await failure(deliver({ url: 'https://attacker.com/hooks/abc' }))).toMatchObject({ reason: 'refused' });
    expect(reads).toBe(1);
    http.assertSentCount(1);
  });
});

describe('ChatPoster: no foreign cause is kept', () => {
  it('drops a transport error that holds the address, wherever it sits in the chain', async () => {
    const leaky = new HttpClient({
      transport: {
        send: async () => {
          throw new Error(`connect failed for ${slackUrl}`, { cause: new Error(`inner ${slackUrl}`, { cause: new Error(slackUrl) }) });
        },
      },
    });
    const { deliver } = setup({ webhooks: { ops: slackUrl }, client: leaky });
    const error = await failure(deliver('ops'));
    expect(error.reason).toBe('unavailable');
    expect(error).not.toHaveProperty('cause');
    for (const text of [error.message, String(error.cause), JSON.stringify(error), inspect(error, { depth: 10 })]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).not.toContain('hooks.slack.com/services');
    }
  });
});

describe('ChatPoster: no error holds the address, in any form', () => {
  const cases: [string, string, string, () => Response | undefined][] = [
    ['slack 400', 'slack', slackUrl, () => reply(400, 'invalid_payload')],
    ['slack 404', 'slack', slackUrl, () => reply(404, 'no_service')],
    ['slack 429', 'slack', slackUrl, () => reply(429, 'rate_limited', { 'retry-after': '3' })],
    ['slack 503', 'slack', slackUrl, () => reply(503, `down ${slackUrl}`)],
    ['slack body that echoes the address', 'slack', slackUrl, () => reply(400, `bad request to ${slackUrl}`)],
    ['discord 404', 'discord', discordUrl, () => reply(404, `{"code":10015,"message":"Unknown Webhook ${discordUrl}"}`)],
    ['discord 429', 'discord', discordUrl, () => reply(429, '{"retry_after":1.5}', { 'retry-after': '1.5' })],
    ['teams 400', 'teams', teamsUrl, () => reply(400, `{"error":{"code":"InvalidRequest","message":"${teamsUrl}"}}`)],
    ['teams 500', 'teams', teamsUrl, () => reply(500, teamsUrl)],
    ['redirect', 'slack', slackUrl, () => reply(302, '', { location: `${slackUrl}?again=1` })],
  ];

  it.each(cases)('%s', async (_name, driver, url, response) => {
    const { http, deliver } = setup({ driver, webhooks: { ops: url } });
    http.respond(/./, response()!);
    const error = await failure(deliver('ops'));
    for (const secret of secrets) expect(shown(error), secret).not.toContain(secret);
    expect(shown(error)).not.toContain('https://hooks.slack.com/services');
    expect(shown(error)).not.toContain('/api/webhooks/');
  });

  it.each(['network', 'timeout', 'aborted', 'refused', 'too-large', 'redirects'] as const)('a failing request: %s', async (reason) => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(200)).failNext(reason);
    const error = await failure(deliver('ops'));
    for (const secret of secrets) expect(shown(error), secret).not.toContain(secret);
  });

  it('a refusal of the guard, for every driver', async () => {
    for (const [driver, url] of [['slack', slackUrl], ['discord', discordUrl], ['teams', teamsUrl]] as const) {
      const { http, deliver } = setup({ driver });
      http.respond(/./, reply(200));
      const evil = url.replace(/^https:\/\/[^/]+/, 'https://evil.example');
      const error = await failure(deliver({ url: evil }));
      for (const secret of secrets) expect(shown(error), `${driver} ${secret}`).not.toContain(secret);
      http.assertNothingSent();
    }
  });

  it('the content of a message is not part of a delivery error either', async () => {
    const { http, deliver } = setup({ webhooks: { ops: slackUrl } });
    http.respond(/./, reply(400, 'invalid_payload'));
    const error = await failure(deliver('ops', { text: 'the password is hunter2' }));
    expect(shown(error)).not.toContain('hunter2');
  });
});

describe('ChatPoster: content reaches the driver unchanged', () => {
  it('renders the normalized content', async () => {
    const seen: ChatContent[] = [];
    const { http, deliver } = setup({
      driver: 'mm',
      custom: { mm: () => ({ hosts: ['chat.example.com'], paths: ['/hooks/'], render: (content) => (seen.push(content), { json: {} }) }) },
      webhooks: { ops: 'https://chat.example.com/hooks/abc' },
    });
    http.respond(/./, reply(200));
    await deliver('ops', { text: '  hi‮  ', fields: [{ label: 'a', value: 'b' }] });
    expect(seen[0]).toMatchObject({ text: 'hi', fields: [{ label: 'a', value: 'b' }] });
  });
});
