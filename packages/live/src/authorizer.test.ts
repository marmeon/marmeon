import { Redactor, type Logger } from '@marmeon/core';
import type { LiveAudience, LiveAuthorizer } from '@marmeon/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLiveBackend } from './backend.ts';
import { LiveStreamController } from './endpoint.ts';
import { LiveHub } from './hub.ts';
import { liveKeys, LiveTokens } from './signer.ts';
import { LiveStreamReader } from './test-stream.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const tokens = new LiveTokens(liveKeys(new Uint8Array(32).fill(7)));
const ADA = 'scope-of-adas-session';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function hubOf(): LiveHub {
  const hub = new LiveHub(new MemoryLiveBackend(), { heartbeatSeconds: 20, retryMs: 3000, maxStreams: 100 }, silent, undefined, new Redactor());
  cleanups.push(() => hub.close());
  return hub;
}

const pair = (channel: string, scope = ADA) => `c=${encodeURIComponent(`${tokens.sign(scope, channel)}.${channel}`)}`;
const request = (query: string) => ({ request: new Request(`http://app.test/_marmeon/live?v=1&${query}`) }) as never;

function controllerOf(hub: LiveHub, authorizer?: LiveAuthorizer | readonly LiveAuthorizer[], audience?: LiveAudience, logger?: Logger) {
  return new LiveStreamController(hub, tokens, 20, () => ADA, audience, logger, new Redactor(), () => (authorizer === undefined ? [] : [authorizer].flat()));
}

describe('LiveAuthorizer — asked at every connection of a stream', () => {
  it('without one bound, every signed channel is followed', async () => {
    const hub = hubOf();
    const stream = new LiveStreamReader(await controllerOf(hub).handle(request(`connection=tab-a-0001&${pair('team.1')}`)));
    cleanups.push(() => stream.close());
    expect(await stream.hello()).toEqual({ seq: { 'team.1': 0 } });
  });

  it('a right that is gone stops the hints at the next connection', async () => {
    const hub = hubOf();
    let member = true;
    const authorizer = { allows: (channel: string) => channel === 'team.1' && member };
    const first = new LiveStreamReader(await controllerOf(hub, authorizer).handle(request(`connection=tab-a-0001&${pair('team.1')}`)));
    cleanups.push(() => first.close());
    expect(await first.hello()).toEqual({ seq: { 'team.1': 0 } });
    member = false;
    // The same signed channel, the same session: the token alone no longer opens a stream.
    const second = await controllerOf(hub, authorizer).handle(request(`connection=tab-a-0002&${pair('team.1')}`));
    expect(second.status).toBe(403);
    expect(hub.size).toBe(1);
  });

  it('a stranger with a valid token but no right is refused', async () => {
    const hub = hubOf();
    const response = await controllerOf(hub, { allows: () => false }).handle(request(`connection=tab-a-0001&${pair('team.9')}`));
    expect([response.status, await response.text()]).toEqual([403, 'Not allowed to follow these channels.']);
    expect(hub.size).toBe(0);
  });

  it('leaves out the channel that is denied and follows the other', async () => {
    const hub = hubOf();
    const asked: string[] = [];
    const authorizer = { allows: async (channel: string) => (asked.push(channel), channel !== 'team.1') };
    const stream = new LiveStreamReader(await controllerOf(hub, authorizer).handle(request(`connection=tab-a-0001&${pair('team.1')}&${pair('notifications.user.1')}`)));
    cleanups.push(() => stream.close());
    expect(await stream.hello()).toEqual({ seq: { 'notifications.user.1': 0 } });
    expect(asked).toEqual(['team.1', 'notifications.user.1']);
    expect(hub.streams()).toEqual([{ scope: ADA, connection: 'tab-a-0001', channels: ['notifications.user.1'] }]);
  });

  it('keeps a channel only for exactly true', async () => {
    const hub = hubOf();
    const truthy = { allows: () => 'yes' as never };
    expect((await controllerOf(hub, truthy).handle(request(`connection=tab-a-0001&${pair('team.1')}`))).status).toBe(403);
    expect(hub.size).toBe(0);
  });

  it('a throw is a 503 with Retry-After and no stream, logged once a minute', async () => {
    const hub = hubOf();
    const error = vi.fn();
    const logger = { error } as unknown as Logger;
    const failing = () => controllerOf(hub, { allows: () => Promise.reject(new Error('down')) }, undefined, logger);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      const response = await failing().handle(request(`connection=tab-a-0001&${pair('team.1')}`));
      expect([response.status, response.headers.get('retry-after')]).toEqual([503, '5']);
      expect((await failing().handle(request(`connection=tab-b-0001&${pair('team.1')}`))).status).toBe(503);
      expect(error).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2031-01-01T00:01:01Z'));
      await failing().handle(request(`connection=tab-c-0001&${pair('team.1')}`));
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(hub.size).toBe(0);
  });

  it('is not asked for a forged token or an ended sign-in', async () => {
    const hub = hubOf();
    const allows = vi.fn(() => true);
    const forged = `c=${encodeURIComponent(`${tokens.sign(ADA, 'team.1')}.team.2`)}`;
    expect((await controllerOf(hub, { allows }).handle(request(`connection=tab-a-0001&${forged}`))).status).toBe(403);
    const ended = await controllerOf(hub, { allows }, { check: async () => ({ kind: 'ended' }) }).handle(request(`connection=tab-a-0001&${pair('team.1')}`));
    expect(await ended.text()).toBe('event: end\ndata: {}\n\n');
    expect(allows).not.toHaveBeenCalled();
    expect(hub.size).toBe(0);
  });
});
