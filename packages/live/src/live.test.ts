import { createServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { runTransaction, type Logger } from '@marmeon/core';
import { RedisConnections, defineRedisScript } from '@marmeon/redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLiveBackend, type LiveBackend, type LiveMessage } from './backend.ts';
import { LiveBroadcaster } from './broadcaster.ts';
import { LiveStreamController } from './endpoint.ts';
import { LiveHub, OpenStream, type LiveHubOptions } from './hub.ts';
import { BroadcastRecorder } from './recorder.ts';
import { RedisLiveBackend } from './redis.ts';
import { liveKeys, LiveTokens } from './signer.ts';
import { LiveStreamReader } from './test-stream.ts';

const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const tokens = new LiveTokens(liveKeys(new Uint8Array(32).fill(7)));
const ADA = 'scope-of-adas-session';
const GRACE = 'scope-of-graces-session';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every hint any stream of these tests sent: only `channel`, `only` and `seq` — never data (the schema test reads these). */
const everyHint: unknown[] = [];

function hubOf(backend: LiveBackend = new MemoryLiveBackend(), options: Partial<LiveHubOptions> = {}, closing?: AbortSignal): LiveHub {
  const hub = new LiveHub(backend, { heartbeat: 20, retry: 3000, maxStreams: 100, ...options }, silent, closing);
  cleanups.push(() => hub.close());
  return hub;
}

async function open(hub: LiveHub, channels: string[], { scope = ADA, connection = 'tab-a-0001', lastEventId, account }: { scope?: string; connection?: string; lastEventId?: string; account?: string } = {}) {
  const reader = new LiveStreamReader(await hub.open({ channels, scope, connection, lastEventId, accounts: account === undefined ? undefined : [account] }));
  cleanups.push(() => reader.close());
  cleanups.push(() => void everyHint.push(...reader.hints));
  return reader;
}

function broadcasterOf(backend: LiveBackend, connection?: string, recorder?: BroadcastRecorder) {
  return new LiveBroadcaster({ backend: () => backend, connection, logger: silent, recorder });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('live tokens — the answer that declares a channel signs it for its session', () => {
  it('verifies a token for its channel and session only — a rewritten channel or another session is refused', () => {
    const token = tokens.sign(ADA, 'users.1');
    expect(tokens.verify(ADA, 'users.1', token)).toBe(true);
    expect(tokens.verify(ADA, 'users.2', token)).toBe(false);
    expect(tokens.verify(GRACE, 'users.1', token)).toBe(false);
    expect(tokens.verify(ADA, 'users.1', token.slice(0, -1))).toBe(false);
  });

  it('keeps accepting tokens of a previous key (APP_PREVIOUS_KEYS) and signs with the current one', () => {
    const old = new LiveTokens(liveKeys(new Uint8Array(32).fill(1)));
    const rotated = new LiveTokens(liveKeys(new Uint8Array(32).fill(2), [new Uint8Array(32).fill(1)]));
    expect(rotated.verify(ADA, 'users.1', old.sign(ADA, 'users.1'))).toBe(true);
    expect(rotated.sign(ADA, 'users.1')).not.toBe(old.sign(ADA, 'users.1'));
  });

  it('signs nothing without a session', () => {
    expect(() => tokens.for(() => undefined).sign('users.1')).toThrow(/this request has none/);
    // A read-only request (a guest's island) cannot start a session: no token — the subscription is left out, no error.
    expect(tokens.for(() => undefined, () => true).sign('users.1')).toBeUndefined();
  });
});

describe('the stream endpoint — GET /_marmeon/live', () => {
  const request = (query: string, headers: Record<string, string> = {}) => ({ request: new Request(`http://app.test/_marmeon/live?${query}`, { headers }) }) as never;
  const pair = (channel: string, scope = ADA) => `c=${encodeURIComponent(`${tokens.sign(scope, channel)}.${channel}`)}`;

  it('opens a stream for channels signed for this session — with the stream headers', async () => {
    const hub = hubOf();
    const controller = new LiveStreamController(hub, tokens, 20, () => ADA);
    const response = await controller.handle(request(`connection=tab-a-0001&${pair('users.1')}&${pair('dashboard.sign-ins')}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('content-encoding')).toBeNull();
    const reader = new LiveStreamReader(response);
    cleanups.push(() => reader.close());
    expect(await reader.hello()).toEqual({ seq: { 'users.1': 0, 'dashboard.sign-ins': 0 } });
    expect(reader.retry).toBe(3000);
    expect(hub.streams()).toEqual([{ scope: ADA, connection: 'tab-a-0001', channels: ['users.1', 'dashboard.sign-ins'] }]);
  });

  it('refuses a token rewritten to another channel (users.1 → users.2): 403, no stream', async () => {
    const hub = hubOf();
    const controller = new LiveStreamController(hub, tokens, 20, () => ADA);
    const forged = `c=${encodeURIComponent(`${tokens.sign(ADA, 'users.1')}.users.2`)}`;
    const response = await controller.handle(request(`connection=tab-a-0001&${pair('dashboard.sign-ins')}&${forged}`));
    expect(response.status).toBe(403);
    expect(hub.size).toBe(0);
  });

  it('refuses a token of another session — or of one that ended (signed out: the cookie names a new session now): 403', async () => {
    const hub = hubOf();
    // The tab's cookie is Grace's session now (another browser's token, or Ada signed out and the id was regenerated).
    const controller = new LiveStreamController(hub, tokens, 20, () => GRACE);
    expect((await controller.handle(request(`connection=tab-a-0001&${pair('users.1', ADA)}`))).status).toBe(403);
    expect(hub.size).toBe(0);
  });

  it('refuses a stream without a connection, without channels, with too many — and one without a session (401)', async () => {
    const hub = hubOf();
    const controller = new LiveStreamController(hub, tokens, 2, () => ADA);
    expect((await controller.handle(request(pair('users.1')))).status).toBe(400);
    expect((await controller.handle(request('connection=tab-a-0001'))).status).toBe(400);
    expect((await controller.handle(request(`connection=tab-a-0001&${pair('a')}&${pair('b')}&${pair('c')}`))).status).toBe(400);
    expect((await new LiveStreamController(hub, tokens, 2, () => undefined).handle(request(`connection=tab-a-0001&${pair('a')}`))).status).toBe(401);
  });

  it('asks the audience after the tokens: an ended sign-in gets `end` and no place in the hub; an open one a stream', async () => {
    const hub = hubOf();
    const ended = new LiveStreamController(hub, tokens, 20, () => ADA, { check: async () => ({ kind: 'ended' }) });
    const response = await ended.handle(request(`connection=tab-a-0001&${pair('users.1')}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('event: end\ndata: {}\n\n');
    expect(hub.size).toBe(0);
    // A forged token is refused before the audience is asked: it learns nothing of the sign-in.
    const forged = `c=${encodeURIComponent(`${tokens.sign(ADA, 'users.1')}.users.2`)}`;
    expect((await ended.handle(request(`connection=tab-a-0001&${forged}`))).status).toBe(403);

    for (const [connection, who] of [['tab-b-0001', { kind: 'guest' }], ['tab-c-0001', { kind: 'account', scope: 'acct-1' }]] as const) {
      const open = new LiveStreamController(hub, tokens, 20, () => ADA, { check: async () => who });
      const stream = new LiveStreamReader(await open.handle(request(`connection=${connection}&${pair('users.1')}`)));
      cleanups.push(() => stream.close());
      await stream.hello();
    }
    expect(hub.size).toBe(2);
  });

  it('refuses with 503 when the audience cannot tell (the database is down), and opens nothing', async () => {
    const hub = hubOf();
    const error = vi.fn();
    const logger = { error } as unknown as Logger;
    const failing = () => new LiveStreamController(hub, tokens, 20, () => ADA, { check: async () => Promise.reject(new Error('down')) }, logger);
    // The log line is throttled per process: move the clock past any earlier test's line.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const response = await failing().handle(request(`connection=tab-a-0001&${pair('users.1')}`));
      expect([response.status, response.headers.get('content-type'), response.headers.get('retry-after')]).toEqual([503, 'text/plain; charset=utf-8', '5']);
      // Another request (a new controller, as every request builds one) within the minute: refused, not logged again.
      expect((await failing().handle(request(`connection=tab-b-0001&${pair('users.1')}`))).status).toBe(503);
      expect(error).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2030-01-01T00:01:01Z'));
      await failing().handle(request(`connection=tab-c-0001&${pair('users.1')}`));
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(hub.size).toBe(0);
  });

  it('holds at most LIVE_MAX_STREAMS streams per process — beyond, 503 with Retry-After until one closes', async () => {
    const hub = hubOf(new MemoryLiveBackend(), { maxStreams: 1 });
    const controller = new LiveStreamController(hub, tokens, 20, () => ADA);
    const first = new LiveStreamReader(await controller.handle(request(`connection=tab-a-0001&${pair('users.1')}`)));
    const refused = await controller.handle(request(`connection=tab-b-0001&${pair('users.1')}`));
    expect([refused.status, refused.headers.get('retry-after')]).toEqual([503, '10']);
    await first.close();
    expect(hub.size).toBe(0);
    const next = await controller.handle(request(`connection=tab-b-0001&${pair('users.1')}`));
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it('holds at most LIVE_MAX_STREAMS_PER_SESSION streams of one session (16): the 17th → 429 with its own log line — other sessions still open', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silent, warn: (message) => void warnings.push(message), child: () => logger };
    const hub = new LiveHub(new MemoryLiveBackend(), { heartbeat: 20, retry: 3000, maxStreams: 100 }, logger);
    cleanups.push(() => hub.close());
    const controller = new LiveStreamController(hub, tokens, 20, () => ADA);
    const opened: LiveStreamReader[] = [];
    for (let tab = 0; tab < 16; tab++) {
      const response = await controller.handle(request(`connection=tab-${String(tab).padStart(2, '0')}-0001&${pair('users.1')}`));
      expect(response.status).toBe(200);
      opened.push(new LiveStreamReader(response));
    }
    cleanups.push(() => Promise.all(opened.map((reader) => reader.close())).then(() => undefined));
    const refused = await controller.handle(request(`connection=tab-16-0001&${pair('users.1')}`));
    if (refused.status === 200) await refused.body?.cancel();
    expect(refused.status).toBe(429);
    expect([refused.headers.get('retry-after'), await refused.text()]).toEqual(['30', 'Too many live streams for this session.']);
    expect(warnings).toEqual(['A session asked for more live streams than it may hold in this process (LIVE_MAX_STREAMS_PER_SESSION); refused with 429']);
    // Another session is not counted with Ada's.
    const grace = await new LiveStreamController(hub, tokens, 20, () => GRACE).handle(request(`connection=tab-g-0001&${pair('users.1', GRACE)}`));
    expect(grace.status).toBe(200);
    await grace.body?.cancel();
    // One of Ada's tabs closes: the next one opens.
    await opened.shift()!.close();
    const next = await controller.handle(request(`connection=tab-17-0001&${pair('users.1')}`));
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it('counts atomically: fifty streams opening at once — never more than the limits (of the process, of a session)', async () => {
    // Fifty tabs whose requests arrive together (a synchronized start: all of them are handled before any stream got further).
    const burst = async (hub: LiveHub, scopes: (tab: number) => string) => {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, tab) => new LiveStreamController(hub, tokens, 20, () => scopes(tab)).handle(request(`connection=tab-${String(tab).padStart(2, '0')}-0001&${pair('users.1', scopes(tab))}`))),
      );
      const statuses = responses.map((response) => response.status);
      await Promise.all(responses.map((response) => response.body?.cancel()));
      return { opened: statuses.filter((status) => status === 200).length, refused: statuses.filter((status) => status !== 200).length };
    };
    // Fifty sessions, ten streams for the process.
    const process = hubOf(new MemoryLiveBackend(), { maxStreams: 10 });
    expect(await burst(process, (tab) => `scope-${tab}`)).toEqual({ opened: 10, refused: 40 });
    // One session, sixteen streams for it.
    const session = hubOf(new MemoryLiveBackend());
    expect(await burst(session, () => ADA)).toEqual({ opened: 16, refused: 34 });
  });
});

describe('the stream — hints, never data', () => {
  it('says hello with each channel’s sequence, then a hint per refresh: { channel, only, seq } — only to followers of the channel', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    await backend.refresh('users.1', null, undefined);
    const ada = await open(hub, ['users.1', 'notifications.user.1']);
    const other = await open(hub, ['users.2'], { connection: 'tab-c-0001' });
    expect(await ada.hello()).toEqual({ seq: { 'users.1': 1, 'notifications.user.1': 0 } });
    await broadcasterOf(backend).refresh('users.1', { only: ['profile'] });
    await broadcasterOf(backend).refresh('notifications.user.1');
    await ada.waitFor(2);
    expect(ada.hints).toEqual([
      { channel: 'users.1', only: ['profile'], seq: 2 },
      { channel: 'notifications.user.1', only: null, seq: 1 },
    ]);
    // The event id carries what the stream saw — the Last-Event-ID of a reconnect.
    expect(ada.events.at(-1)?.id).toBe('users.1=2&notifications.user.1=1');
    await settle();
    expect(other.hints).toEqual([]);
  });

  it('a hint goes to the streams of its channel only (the index) — a session’s end to that session’s streams only', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const followers = [await open(hub, ['users.1'], { connection: 'tab-a-0001' }), await open(hub, ['users.1', 'users.2'], { scope: GRACE, connection: 'tab-b-0001' })];
    const others = await Promise.all(Array.from({ length: 30 }, (_, tab) => open(hub, [`users.${100 + tab}`], { scope: `scope-${tab}`, connection: `tab-${String(tab).padStart(2, '0')}-0002` })));
    await Promise.all([...followers, ...others].map((reader) => reader.hello()));
    const hinted = vi.spyOn(OpenStream.prototype, 'hint');
    const ended = vi.spyOn(OpenStream.prototype, 'end');
    cleanups.push(() => void (hinted.mockRestore(), ended.mockRestore()));
    await broadcasterOf(backend).refresh('users.1');
    await Promise.all(followers.map((reader) => reader.waitFor(1)));
    // Two streams follow users.1: two deliveries — not one per stream of the process (32).
    expect(hinted).toHaveBeenCalledTimes(2);
    await backend.end(GRACE);
    await followers[1]!.closed;
    expect(ended).toHaveBeenCalledTimes(1);
    expect(others.every((reader) => reader.events.length === 1)).toBe(true);
  });

  it('a refresh never carries data — whatever a caller passes besides `only` (the schema of every hint of these tests)', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const ada = await open(hub, ['users.1']);
    await ada.hello();
    await broadcasterOf(backend).refresh('users.1', { only: ['profile'], data: { secret: 'CANARY' }, props: { email: 'CANARY' } } as never);
    await broadcasterOf(backend, 'tab-a-0001').refresh('users.1', { profile: { email: 'CANARY' } } as never);
    await broadcasterOf(backend).refresh('users.1', { only: [], payload: 'CANARY' } as never);
    await ada.waitFor(3);
    expect(JSON.stringify(ada.events)).not.toContain('CANARY');
    everyHint.push(...ada.hints);
    for (const hint of everyHint) {
      expect(Object.keys(hint as object).sort()).toEqual(['channel', 'only', 'seq']);
      const { channel, only, seq } = hint as { channel: unknown; only: unknown; seq: unknown };
      expect(typeof channel).toBe('string');
      expect(typeof seq).toBe('number');
      expect(only === null || (Array.isArray(only) && only.every((name) => typeof name === 'string'))).toBe(true);
    }
    expect(everyHint.length).toBeGreaterThan(2);
  });

  it('the tab that caused a refresh (x-marmeon-connection) gets it with nothing to reload — the others with its props', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const a = await open(hub, ['users.1'], { connection: 'tab-a-0001' });
    const b = await open(hub, ['users.1'], { connection: 'tab-b-0001' });
    await Promise.all([a.hello(), b.hello()]);
    await broadcasterOf(backend, 'tab-a-0001').refresh('users.1', { only: ['profile'] });
    await Promise.all([a.waitFor(1), b.waitFor(1)]);
    expect(a.hints).toEqual([{ channel: 'users.1', only: [], seq: 1 }]);
    expect(b.hints).toEqual([{ channel: 'users.1', only: ['profile'], seq: 1 }]);
  });

  it('a hint that arrives while hello is prepared goes out right after it — once, and not when hello counted it', async () => {
    const backend = new MemoryLiveBackend();
    let read!: () => void;
    let send!: () => void;
    const reading = new Promise<void>((resolve) => (read = resolve));
    const sending = new Promise<void>((resolve) => (send = resolve));
    // hello reads the sequences — then goes out a little later (a Redis round trip): hints in between must not be lost.
    const slow: LiveBackend = {
      refresh: backend.refresh.bind(backend),
      end: backend.end.bind(backend),
      listen: backend.listen.bind(backend),
      close: backend.close.bind(backend),
      seqs: async (channels) => {
        await reading;
        const seqs = await backend.seqs(channels);
        await sending;
        return seqs;
      },
    };
    const hub = hubOf(slow);
    const opening = hub.open({ channels: ['users.1'], scope: ADA, connection: 'tab-a-0001' });
    await settle();
    await backend.refresh('users.1', null, undefined); // seq 1 — before hello reads: hello counts it
    read();
    await settle();
    await backend.refresh('users.1', null, undefined); // seq 2 — after hello read, before it went out
    send();
    const reader = new LiveStreamReader(await opening);
    cleanups.push(() => reader.close());
    await reader.waitFor(1);
    await settle();
    expect((await reader.hello()).seq).toEqual({ 'users.1': 1 });
    expect(reader.hints.map((hint) => hint.seq)).toEqual([2]);
  });

  it('reconnecting with Last-Event-ID: hello names the channels whose sequence moved meanwhile', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const first = await open(hub, ['users.1', 'dashboard.sign-ins']);
    await first.hello();
    await backend.refresh('users.1', null, undefined);
    await first.waitFor(1);
    const lastEventId = first.events.at(-1)!.id!;
    await first.close();
    // While it was away: one more hint on the profile, none on the island.
    await backend.refresh('users.1', ['profile'], undefined);
    const again = await open(hub, ['users.1', 'dashboard.sign-ins'], { lastEventId });
    expect(await again.hello()).toEqual({ seq: { 'users.1': 2, 'dashboard.sign-ins': 0 }, missed: ['users.1'] });
  });

  it('sends heartbeats on an idle stream (a comment line, every LIVE_HEARTBEAT_SECONDS)', async () => {
    const hub = hubOf(new MemoryLiveBackend(), { heartbeat: 0.02 });
    const reader = await open(hub, ['users.1']);
    await reader.waitFor(() => reader.heartbeats >= 3);
    expect(reader.hints).toEqual([]);
  });

  it('a session that ended (signed out, in any process): its streams get `end` and close — no further hints; others stay', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const adaA = await open(hub, ['users.1'], { connection: 'tab-a-0001' });
    const adaB = await open(hub, ['users.1'], { connection: 'tab-b-0001' });
    const grace = await open(hub, ['users.1'], { scope: GRACE, connection: 'tab-g-0001' });
    await Promise.all([adaA.hello(), adaB.hello(), grace.hello()]);
    await backend.end(ADA);
    await Promise.all([adaA.closed, adaB.closed]);
    expect(adaB.events.at(-1)).toEqual({ event: 'end', id: undefined, data: {} });
    await backend.refresh('users.1', null, undefined);
    await grace.waitFor(1);
    expect(adaB.hints).toEqual([]);
    expect(hub.size).toBe(1);
  });

  it('the sign-ins of an account ended: its streams close without `end` and with a pause to reconnect after — other accounts, guests and the sessions stay', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const adaA = await open(hub, ['users.1'], { connection: 'tab-a-0001', scope: 'session-a1', account: 'a:ada' });
    const adaB = await open(hub, ['users.1'], { connection: 'tab-b-0001', scope: 'session-a2', account: 'a:ada' });
    const grace = await open(hub, ['users.1'], { connection: 'tab-g-0001', scope: 'session-g', account: 'a:grace' });
    const guest = await open(hub, ['users.1'], { connection: 'tab-x-0001', scope: 'session-x' });
    await Promise.all([adaA.hello(), adaB.hello(), grace.hello(), guest.hello()]);
    // The name of a session is no name of an account, and a guess is no name of either.
    await backend.end('session-g-but-not');
    await backend.end('a:ada');
    await Promise.all([adaA.closed, adaB.closed]);
    for (const reader of [adaA, adaB]) {
      expect(reader.events.map((each) => each.event)).toEqual(['hello']);
      expect(reader.retry).toBeGreaterThanOrEqual(1000);
      expect(reader.retry).toBeLessThanOrEqual(10_000);
    }
    expect(hub.size).toBe(2);
    await backend.refresh('users.1', null, undefined);
    await Promise.all([grace.waitFor(1), guest.waitFor(1)]);
  });

  it('a rollout of `APP_KEY`: an end announced under either key closes the streams of a process on the other, each once', async () => {
    const k0 = liveKeys(new Uint8Array(32).fill(1));
    const k1 = liveKeys(new Uint8Array(32).fill(2), [new Uint8Array(32).fill(1)]);
    // `from` announces the end the way the live wiring does (one message per key it knows), `to` has the streams.
    for (const [from, to] of [[k0, k1], [k1, k0], [k1, k1]] as const) {
      const backend = new MemoryLiveBackend();
      const hub = hubOf(backend);
      const process = new LiveTokens(to);
      const reader = new LiveStreamController(hub, process, 20, () => ADA, { check: async () => ({ kind: 'account', scope: 'acct-1' }) });
      const stream = new LiveStreamReader(await reader.handle({ request: new Request(`http://app.test/_marmeon/live?connection=tab-a-0001&c=${encodeURIComponent(`${process.sign(ADA, 'users.1')}.users.1`)}`) } as never));
      cleanups.push(() => stream.close());
      await stream.hello();
      for (const keyed of new LiveTokens(from).accountScopes('acct-1')) await backend.end(keyed);
      await stream.closed;
      expect(stream.events.map((each) => each.event)).toEqual(['hello']);
      expect(hub.size).toBe(0);
    }
  });

  it('a stream filed under two scopes is closed once by `*` and leaves every index', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const reader = await open(hub, ['users.1'], { connection: 'tab-a-0001', scope: 'session-a' });
    const both = new LiveStreamReader(await hub.open({ channels: ['users.1'], scope: 'session-b', accounts: ['a:new', 'a:old'], connection: 'tab-b-0001' }));
    cleanups.push(() => both.close());
    await Promise.all([reader.hello(), both.hello()]);
    const close = vi.spyOn(OpenStream.prototype, 'reconnect');
    try {
      await backend.end('*');
      await both.closed;
      expect(close).toHaveBeenCalledTimes(1);
      expect(hub.size).toBe(1);
      // Neither scope names the stream any more: a later end finds nothing to close.
      await backend.end('a:old');
      await backend.end('a:new');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it('every account ended (\'*\'): every account\'s streams close, a guest\'s stays', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const ada = await open(hub, ['users.1'], { connection: 'tab-a-0001', scope: 'session-a', account: 'a:ada' });
    const grace = await open(hub, ['users.1'], { connection: 'tab-g-0001', scope: 'session-g', account: 'a:grace' });
    const guest = await open(hub, ['users.1'], { connection: 'tab-x-0001', scope: 'session-x' });
    await Promise.all([ada.hello(), grace.hello(), guest.hello()]);
    await backend.end('*');
    await Promise.all([ada.closed, grace.closed]);
    expect(hub.size).toBe(1);
    await backend.refresh('users.1', null, undefined);
    await guest.waitFor(1);
  });

  it('a stream lives at most LIVE_MAX_STREAM_SECONDS (a quarter less at most): it closes without `end` and its browser connects again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hub = hubOf(new MemoryLiveBackend(), { maxStreamSeconds: 100 });
      const reader = await open(hub, ['users.1'], { account: 'a:ada' });
      await reader.hello();
      await vi.advanceTimersByTimeAsync(74_000);
      expect(hub.size).toBe(1); // never before three quarters
      await vi.advanceTimersByTimeAsync(27_000);
      await reader.closed;
      expect(reader.events.map((each) => each.event)).toEqual(['hello']);
      expect(hub.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an end of the account that arrived after its sign-in was asked about: the stream, opened on that answer, closes again at once', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    await open(hub, ['users.1'], { account: 'other' }).then((reader) => reader.hello()); // the hub listens
    const checkedAt = Date.now();
    await backend.end('a:ada');
    const stale = new LiveStreamReader(await hub.open({ channels: ['users.1'], scope: 'session-a', accounts: ['a:ada'], checkedAt, connection: 'tab-s-0001' }));
    cleanups.push(() => stale.close());
    await stale.closed;
    expect(stale.events.map((each) => each.event)).toEqual(['hello']);
    // Asked after the end: it stands.
    const later = new LiveStreamReader(await hub.open({ channels: ['users.1'], scope: 'session-b', accounts: ['a:ada'], checkedAt: Date.now() + 1, connection: 'tab-t-0001' }));
    cleanups.push(() => later.close());
    await later.hello();
    // `*` counts as well.
    await backend.end('*');
    const star = new LiveStreamReader(await hub.open({ channels: ['users.1'], scope: 'session-c', accounts: ['a:eve'], checkedAt: Date.now() - 5, connection: 'tab-u-0001' }));
    cleanups.push(() => star.close());
    await star.closed;
  });

  it('remembers only the ends of accounts (and `*`), forgets them after a minute, and keeps them in time order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      const backend = new MemoryLiveBackend();
      const hub = hubOf(backend);
      await (await open(hub, ['users.1'], { account: 'a:other' })).hello();
      for (let i = 0; i < 50; i++) await backend.end(`session-${i}`);
      expect(hub.endsRemembered).toBe(0);
      await backend.end('a:ada');
      await backend.end('a:grace');
      await backend.end('a:ada'); // again: moves to the end, still two entries
      expect(hub.endsRemembered).toBe(2);
      vi.setSystemTime(new Date('2031-01-01T00:01:30Z'));
      await backend.end('a:eve');
      expect(hub.endsRemembered).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('LiveTokens names the account under every key, the current one first', () => {
    const both = new LiveTokens(liveKeys(new Uint8Array(32).fill(2), [new Uint8Array(32).fill(1)]));
    const old = new LiveTokens(liveKeys(new Uint8Array(32).fill(1)));
    expect(both.accountScopes('abc')).toEqual([both.accountScope('abc'), old.accountScope('abc')]);
  });

  it('the account scope that crosses the backend is keyed: it is not the unkeyed one, and another key makes another', () => {
    const one = new LiveTokens(liveKeys(new Uint8Array(32).fill(1)));
    const two = new LiveTokens(liveKeys(new Uint8Array(32).fill(2)));
    expect(one.accountScope('abc')).not.toBe('abc');
    expect(one.accountScope('abc')).toBe(one.accountScope('abc'));
    expect(one.accountScope('abc')).not.toBe(two.accountScope('abc'));
    expect(one.accountScope('abc')).not.toBe(one.accountScope('abd'));
  });

  it('the server closing ends every stream (without `end`: the browser reconnects to the next server)', async () => {
    const closing = new AbortController();
    const hub = hubOf(new MemoryLiveBackend(), {}, closing.signal);
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    closing.abort();
    await reader.closed;
    expect(reader.events.map((each) => each.event)).toEqual(['hello']);
    expect(hub.size).toBe(0);
  });

  it('the server began closing: a stream asked for afterwards is refused (503) — none opens that would hold server.close()', async () => {
    const closing = new AbortController();
    const hub = hubOf(new MemoryLiveBackend(), {}, closing.signal);
    closing.abort();
    const late = await hub.open({ channels: ['users.1'], scope: ADA, connection: 'tab-a-0001' });
    await late.body?.cancel();
    expect([late.status, late.headers.get('retry-after'), hub.size]).toEqual([503, '1', 0]);
    // A hub made after the server began closing knows it, too.
    const after = hubOf(new MemoryLiveBackend(), {}, closing.signal);
    const refused = await after.open({ channels: ['users.1'], scope: ADA, connection: 'tab-a-0001' });
    await refused.body?.cancel();
    expect([refused.status, after.size]).toEqual([503, 0]);
  });

  it('the server closing while a stream is being opened (hello on its way): that stream is refused and gone too', async () => {
    const closing = new AbortController();
    const backend = new MemoryLiveBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: LiveBackend = { refresh: backend.refresh.bind(backend), end: backend.end.bind(backend), listen: backend.listen.bind(backend), close: backend.close.bind(backend), seqs: async (channels) => (await gate, backend.seqs(channels)) };
    const hub = hubOf(slow, {}, closing.signal);
    const opening = hub.open({ channels: ['users.1'], scope: ADA, connection: 'tab-a-0001' });
    await settle();
    closing.abort();
    release();
    const response = await opening;
    await response.body?.cancel();
    expect([response.status, hub.size]).toEqual([503, 0]);
  });

  it('a tab that goes away closes its stream (the hub lets go of it)', async () => {
    const hub = hubOf();
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    expect(hub.size).toBe(1);
    await reader.close();
    expect(hub.size).toBe(0);
  });
});

describe('a channel whose counter started again (its key expired, was evicted or flushed)', () => {
  /** A backend whose sequences can be forgotten — what Redis does after a day without hints (TTL), an eviction or a flush. */
  function forgetful() {
    const memory = new MemoryLiveBackend();
    const listeners = new Set<(message: LiveMessage) => void>();
    let seqs = new Map<string, number>();
    const backend: LiveBackend = {
      refresh: async (channel, only, except) => {
        const seq = (seqs.get(channel) ?? 0) + 1;
        seqs.set(channel, seq);
        for (const listener of listeners) listener({ kind: 'refresh', channel, only, seq, ...(except === undefined ? {} : { except }) });
        return seq;
      },
      end: memory.end.bind(memory),
      seqs: async (channels) => channels.map((channel) => seqs.get(channel) ?? 0),
      listen: async (listener) => (listeners.add(listener), async () => void listeners.delete(listener)),
      close: async () => listeners.clear(),
    };
    return { backend, forget: () => (seqs = new Map()) };
  }

  it('an open stream that saw 5 is told the hints of the new count (1, 2, …) — never drops them as old', async () => {
    const { backend, forget } = forgetful();
    const hub = hubOf(backend);
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    for (let n = 0; n < 5; n++) await backend.refresh('users.1', ['profile'], undefined);
    await reader.waitFor(5);
    forget();
    await backend.refresh('users.1', ['profile'], undefined);
    await backend.refresh('users.1', ['profile'], undefined);
    await reader.waitFor(7);
    expect(reader.hints.map((hint) => hint.seq)).toEqual([1, 2, 3, 4, 5, 1, 2]);
  });

  it('a reconnect with a Last-Event-ID above the new count: hello names the channel as missed — the tab reloads once', async () => {
    const { backend, forget } = forgetful();
    const hub = hubOf(backend);
    for (let n = 0; n < 5; n++) await backend.refresh('users.1', null, undefined);
    forget();
    await backend.refresh('users.1', null, undefined);
    const reader = await open(hub, ['users.1'], { lastEventId: 'users.1=5' });
    expect(await reader.hello()).toEqual({ seq: { 'users.1': 1 }, missed: ['users.1'] });
  });
});

describe('the memory backend — bounded like Redis', () => {
  it('forgets the channel hinted longest ago beyond maxChannels, and a channel a day after its last hint', async () => {
    let now = 0;
    const backend = new MemoryLiveBackend({ maxChannels: 3, now: () => now });
    for (const channel of ['users.1', 'users.2', 'users.3']) await backend.refresh(channel, null, undefined);
    await backend.refresh('users.1', null, undefined); // hinted again: the newest now
    await backend.refresh('users.4', null, undefined); // one too many: users.2 (hinted longest ago) goes
    expect(await backend.seqs(['users.1', 'users.2', 'users.3', 'users.4'])).toEqual([2, 0, 1, 1]);
    now = 86_400_000 - 1;
    expect(await backend.seqs(['users.1'])).toEqual([2]);
    now = 86_400_000;
    expect(await backend.seqs(['users.1', 'users.3', 'users.4'])).toEqual([0, 0, 0]);
  });

  it('a forgotten channel counts on above every forgotten sequence — a stream still open takes its next hint', async () => {
    const backend = new MemoryLiveBackend({ maxChannels: 2 });
    const hub = hubOf(backend);
    const reader = await open(hub, ['users.1']);
    for (let n = 0; n < 5; n++) await backend.refresh('users.1', null, undefined);
    await reader.waitFor(5);
    // Two other channels push users.1 out — the stream saw 5.
    await backend.refresh('users.2', null, undefined);
    await backend.refresh('users.3', null, undefined);
    expect(await backend.seqs(['users.1'])).toEqual([0]);
    expect(await backend.refresh('users.1', null, undefined)).toBe(6);
    await reader.waitFor(6);
    expect(reader.hints.at(-1)).toEqual({ channel: 'users.1', only: null, seq: 6 });
  });
});

describe('the Broadcaster — after the commit, never in a rollback', () => {
  const owner = {};

  it('inside a transaction the hint goes out once it committed — not before', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    const recorder = new BroadcastRecorder();
    await runTransaction(owner, 'default', async () => {
      await broadcasterOf(backend, undefined, recorder).refresh('users.1', { only: ['profile'] });
      await settle();
      expect(reader.hints).toEqual([]);
      recorder.assertNothingRefreshed();
    });
    await reader.waitFor(1);
    recorder.assertRefreshed('users.1', { only: ['profile'], times: 1 });
  });

  it('a transaction that rolls back sends nothing', async () => {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend);
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    const recorder = new BroadcastRecorder();
    await expect(
      runTransaction(owner, 'default', async () => {
        await broadcasterOf(backend, undefined, recorder).refresh('users.1');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await settle();
    expect(reader.hints).toEqual([]);
    expect(await backend.seqs(['users.1'])).toEqual([0]);
    recorder.assertNothingRefreshed();
    expect(() => recorder.assertRefreshed('users.1')).toThrow('Expected users.1 to be refreshed — refreshed: nothing.');
  });

  it('refuses a channel that is no name and an `only` that is no list', async () => {
    const broadcast = broadcasterOf(new MemoryLiveBackend());
    await expect(broadcast.refresh('users 1')).rejects.toThrow(/a live channel is a name/);
    await expect(broadcast.refresh('users.1', { only: 'profile' } as never)).rejects.toThrow(/only is a list of prop names/);
  });

  it('a backend that fails loses the hint, not the request (logged)', async () => {
    const errors: string[] = [];
    const logger: Logger = { ...silent, error: (message) => void errors.push(message), child: () => logger };
    const memory = new MemoryLiveBackend();
    const failing: LiveBackend = { refresh: async () => Promise.reject(new Error('down')), end: (scope) => memory.end(scope), seqs: (channels) => memory.seqs(channels), listen: (listener) => memory.listen(listener), close: () => memory.close() };
    await new LiveBroadcaster({ backend: () => failing, connection: undefined, logger }).refresh('users.1');
    expect(errors).toEqual(['A live hint on "users.1" could not be sent']);
  });
});

describe('a heartbeat keeps a stream alive behind a proxy with an idle timeout', () => {
  /** A TCP proxy that cuts a connection silent for `idle` ms — as nginx, a load balancer or a NAT does. */
  async function proxy(target: number, idle: number): Promise<{ port: number; cut: () => number; close: () => Promise<void> }> {
    let cuts = 0;
    const server: TcpServer = createTcpServer((client) => {
      const upstream = connect(target, '127.0.0.1');
      for (const socket of [client, upstream]) {
        socket.setTimeout(idle, () => {
          cuts++;
          client.destroy();
          upstream.destroy();
        });
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, cut: () => cuts, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  async function streamThroughProxy(heartbeat: number) {
    const backend = new MemoryLiveBackend();
    const hub = hubOf(backend, { heartbeat });
    const app: Server = createServer(async (_request, response) => {
      const answer = await hub.open({ channels: ['users.1'], scope: ADA, connection: 'tab-a-0001' });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      for await (const chunk of answer.body!) response.write(chunk);
      response.end();
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => (app.closeAllConnections(), app.close(() => resolve()))));
    // Idle timeout 400 ms, heartbeat 150 ms (2 s / 1 s scaled down five-fold): alive after 2 s?
    const through = await proxy((app.address() as AddressInfo).port, 400);
    cleanups.push(through.close);
    const reader = new LiveStreamReader(await fetch(`http://127.0.0.1:${through.port}/`));
    cleanups.push(() => reader.close());
    await reader.hello();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { backend, reader, through };
  }

  it('heartbeats every 150 ms keep the stream through a proxy that cuts after 400 ms of silence — a hint after 2 s arrives', async () => {
    const { backend, reader, through } = await streamThroughProxy(0.15);
    expect(reader.ended).toBe(false);
    expect(through.cut()).toBe(0);
    await backend.refresh('users.1', ['profile'], undefined);
    await reader.waitFor(1);
    expect(reader.hints).toEqual([{ channel: 'users.1', only: ['profile'], seq: 1 }]);
  }, 10_000);
});

describe.runIf(REDIS_URL)('the redis backend — every process hears every hint', () => {
  /** A process of the app: its own Redis connections (its own sockets), backend and hub. */
  function processOf(prefix: string) {
    const connections = new RedisConnections({ connections: { default: { url: REDIS_URL!, prefix } }, logger: silent });
    const backend = new RedisLiveBackend({ connection: connections.get(), script: defineRedisScript, logger: silent });
    const hub = hubOf(backend);
    cleanups.push(async () => {
      // What the test left in Redis goes, whatever happened (a failing assertion included).
      const keys = await connections.get().command<string[]>(['KEYS', `${prefix}*`]);
      if (keys.length > 0) await connections.get().command(['DEL', ...keys]);
      await connections.close();
    });
    return { backend, hub, connections };
  }

  it('a refresh in one process reaches a stream in the other — with the shared sequence', async () => {
    const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
    const one = processOf(prefix);
    const two = processOf(prefix);
    const reader = await open(two.hub, ['users.1']);
    expect(await reader.hello()).toEqual({ seq: { 'users.1': 0 } });
    await broadcasterOf(one.backend, 'tab-x-0001').refresh('users.1', { only: ['profile'] });
    await broadcasterOf(one.backend).refresh('users.1');
    await reader.waitFor(2);
    expect(reader.hints).toEqual([
      { channel: 'users.1', only: ['profile'], seq: 1 },
      { channel: 'users.1', only: null, seq: 2 },
    ]);
    expect(await one.backend.seqs(['users.1', 'users.2'])).toEqual([2, 0]);
    const keys = await one.connections.get().command<string[]>(['KEYS', `${prefix}*`]);
    expect(keys).toEqual([`${prefix}live:seq:users.1`]);
    expect(Number(await one.connections.get().command(['TTL', keys[0]!]))).toBeGreaterThan(80_000);
  });

  it('the sequence key expired (a day without hints) or was deleted: the open stream still hears the hints that count from 1 again', async () => {
    const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
    const { backend, hub, connections } = processOf(prefix);
    const reader = await open(hub, ['users.1']);
    await reader.hello();
    for (let n = 0; n < 3; n++) await backend.refresh('users.1', null, undefined);
    await reader.waitFor(3);
    await connections.get().command(['DEL', connections.get().key('live:seq:users.1')]);
    expect(await backend.refresh('users.1', null, undefined)).toBe(1);
    await reader.waitFor(4);
    expect(reader.hints.map((hint) => hint.seq)).toEqual([1, 2, 3, 1]);
  });

  it('a session that ended in one process closes its streams in the other', async () => {
    const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
    const one = processOf(prefix);
    const two = processOf(prefix);
    const reader = await open(two.hub, ['users.1']);
    await reader.hello();
    await one.backend.end(ADA);
    await reader.closed;
    expect(reader.events.at(-1)?.event).toBe('end');
  });

  it('an account that ended in one process closes its streams in the other — and `*` every account\'s, not a guest\'s', async () => {
    const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
    const one = processOf(prefix);
    const two = processOf(prefix);
    const ada = await open(two.hub, ['users.1'], { connection: 'tab-a-0001', scope: 'session-a', account: 'a:ada' });
    const grace = await open(two.hub, ['users.1'], { connection: 'tab-g-0001', scope: 'session-g', account: 'a:grace' });
    const guest = await open(two.hub, ['users.1'], { connection: 'tab-x-0001', scope: 'session-x' });
    await Promise.all([ada.hello(), grace.hello(), guest.hello()]);
    await one.backend.end('a:ada');
    await ada.closed;
    expect(ada.events.map((each) => each.event)).toEqual(['hello']);
    await one.backend.end('*');
    await grace.closed;
    expect(two.hub.size).toBe(1);
    await one.backend.refresh('users.1', null, undefined);
    await guest.waitFor(1);
  });
});
