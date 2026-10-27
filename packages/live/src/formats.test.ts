import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RedisConnection, RedisScript } from '@marmeon/redis';
import { Redactor } from '@marmeon/core';
import { LIVE_VERSION } from '@marmeon/http/internal';
import { describe, expect, it } from 'vitest';
import { MemoryLiveBackend, parseMessage } from './backend.ts';
import { LiveStreamController } from './endpoint.ts';
import { END_FRAME, LiveHub } from './hub.ts';
import { RedisLiveBackend } from './redis.ts';
import { liveKeys, LiveTokens } from './signer.ts';
import { LiveStreamReader } from './test-stream.ts';

const formats = join(import.meta.dirname, '__fixtures__', 'formats');
const files = (format: string, extension: string) => {
  const names = readdirSync(join(formats, format)).sort();
  for (const name of names) expect(name, format).toMatch(new RegExp(`^v1(-[a-z-]+)?\\.${extension}$`));
  return names.map((name) => ({ name, text: readFileSync(join(formats, format, name), 'utf8') }));
};

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const ADA = 'scope-of-adas-session';
const CONNECTION = '0123456789abcdef01234567';
const tokens = new LiveTokens(liveKeys(new Uint8Array(32).fill(7)));
const options = { heartbeatSeconds: 20, retryMs: 3000, maxStreams: 10 };

describe('the live stream: the fixtures of every version it once spoke', () => {
  it('speaks the version its fixtures are of', () => {
    expect(LIVE_VERSION).toBe('1');
  });

  it('the query of a stream is read by the endpoint: the version, the connection, a signed channel each', async () => {
    const [fixture, ...more] = files('stream-query', 'txt');
    expect(more).toEqual([]);
    const query = fixture!.text.trim().replace(/TOKEN\.([\w.-]+)/g, (_all, channel: string) => encodeURIComponent(`${tokens.sign(ADA, channel)}.${channel}`));
    const hub = new LiveHub(new MemoryLiveBackend(), options, silent, undefined, new Redactor());
    const controller = new LiveStreamController(hub, tokens, 20, () => ADA, undefined, undefined, new Redactor());
    const reader = new LiveStreamReader(await controller.handle({ request: new Request(`http://app.test/_marmeon/live?${query}`) } as never));
    try {
      expect(reader.status).toBe(200);
      expect(await reader.hello()).toEqual({ seq: { 'dashboard.sign-ins': 0, 'users.1': 0 } });
      expect(hub.streams()).toEqual([{ scope: ADA, connection: CONNECTION, channels: ['dashboard.sign-ins', 'users.1'] }]);
    } finally {
      await reader.close();
      await hub.close();
    }
  });

  it('the frames of a stream are read as a tab reads them: retry, hello, a hint, a heartbeat, end', async () => {
    const [fixture, ...more] = files('stream', 'txt');
    expect(more).toEqual([]);
    const reader = new LiveStreamReader(new Response(fixture!.text));
    await reader.closed;
    expect(reader.retryMs).toBe(3000);
    expect(reader.heartbeats).toBe(1);
    expect(reader.events).toEqual([
      { event: 'hello', id: 'users.1=2', data: { seq: { 'users.1': 2 } } },
      { event: 'refresh', id: 'users.1=3', data: { channel: 'users.1', only: ['posts'], seq: 3 } },
      { event: 'end', id: undefined, data: {} },
    ]);
  });

  it('the hub writes those frames, byte for byte', async () => {
    const backend = new MemoryLiveBackend();
    await backend.refresh('users.1', null, undefined);
    await backend.refresh('users.1', null, undefined);
    const hub = new LiveHub(backend, options, silent, undefined, new Redactor());
    try {
      const response = await hub.open({ channels: ['users.1'], scope: ADA, connection: CONNECTION });
      await backend.refresh('users.1', ['posts'], undefined);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: refresh')) text += decoder.decode((await reader.read()).value, { stream: true });
      await reader.cancel();
      const fixture = files('stream', 'txt')[0]!.text;
      expect(text).toBe(fixture.slice(0, fixture.indexOf(': heartbeat')));
      expect(fixture.endsWith(END_FRAME)).toBe(true);
    } finally {
      await hub.close();
    }
  });
});

describe('the live message between nodes: the fixtures of every version it once spoke', () => {
  /** A backend over a connection that records what it publishes; the script appends the sequence 7 the counter would give. */
  const published = () => {
    const sent: string[] = [];
    const connection = {
      key: (name: string) => name,
      run: async (_script: RedisScript, _keys: string[], args: (string | number)[]) => {
        sent.push(`${args[1]}7}`);
        return 7;
      },
      command: async (command: string[]) => void sent.push(command[2]!),
    } as unknown as RedisConnection;
    return { backend: new RedisLiveBackend({ connection, script: () => ({}) as RedisScript, logger: silent }), sent };
  };
  const named = (name: string) => files('redis-message', 'json').find((file) => file.name === name)!.text.trim();

  it('reads every fixture', () => {
    for (const { name, text } of files('redis-message', 'json')) expect(parseMessage(text), name).toBeDefined();
    expect(parseMessage(named('v1-refresh.json'))).toEqual({ kind: 'refresh', channel: 'users.1', only: ['posts', 'comments'], seq: 7, except: CONNECTION });
    expect(parseMessage(named('v1-refresh-all.json'))).toEqual({ kind: 'refresh', channel: 'dashboard.sign-ins', only: null, seq: 7 });
    expect(parseMessage(named('v1-end.json'))).toEqual({ kind: 'end', scope: ADA });
  });

  it('refuses what it does not know: a message without its version or of another, another kind, a refresh without its sequence, text that is no JSON', () => {
    for (const text of ['{"v":1,"kind":"reload","channel":"users.1","seq":1}', '{"kind":"end","scope":"a"}', '{"v":2,"kind":"end","scope":"a"}', '{"v":"1","kind":"end","scope":"a"}', '{"kind":"refresh","channel":"users.1","only":null,"seq":1}', '{"v":1,"kind":"refresh","channel":"users.1","only":null}', '{"v":1,"kind":"end"}', 'refresh', '']) expect(parseMessage(text), text).toBeUndefined();
  });

  it('the Redis backend publishes the bytes of the fixtures', async () => {
    const { backend, sent } = published();
    await backend.refresh('users.1', ['posts', 'comments'], CONNECTION);
    await backend.end(ADA);
    expect(sent).toEqual([named('v1-refresh.json'), named('v1-end.json')]);
    const all = published();
    await all.backend.refresh('dashboard.sign-ins', null, undefined);
    expect(all.sent).toEqual([named('v1-refresh-all.json')]);
  });
});
