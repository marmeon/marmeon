import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type PageObject } from '@marmeon/http';
import { ServerServiceProvider, startServer } from '@marmeon/server';
import { SessionEndings, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { LiveBackend, MemoryLiveBackend } from './backend.ts';
import { LiveHub } from './hub.ts';
import { Broadcaster, LiveServiceProvider } from './index.ts';
import { LiveStreamReader } from './test-stream.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

const root = tempDir('marmeon-live-');
writeFileSync(join(root, 'index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
writeFileSync(join(root, 'ssr.ts'), 'export const render = async () => ({ html: "" });');
mkdirSync(join(root, 'node_modules'));
symlinkSync(dirname(createRequire(import.meta.url).resolve('vite/package.json')), join(root, 'node_modules/vite'), 'dir');

class ShowBoardController extends Controller {
  handle() {
    return this.view('board/Show', { cards: [] }).live('board.1');
  }
}

describe('a live stream and the server', () => {
  it('startServer().close() ends the open streams — it is not held up by a tab that never goes away', async () => {
    const app = await createApplication({
      root,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ServerServiceProvider, LiveServiceProvider],
      modules: [defineModule({ name: 'board', routes: openRoutes((Route) => void Route.get('/board', ShowBoardController)) })],
    }, { env: { APP_KEY: generateKey(), PORT: '1', SESSION_DRIVER: 'memory' } });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/board`, { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
    const page = (await answer.json()) as PageObject;
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = page.live![0]!;
    const stream = new LiveStreamReader(
      await fetch(`http://127.0.0.1:${port}/_marmeon/live?connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`, { headers: { accept: 'text/event-stream', cookie } }),
    );
    expect(await stream.hello()).toEqual({ seq: { 'board.1': 0 } });
    // Read-only: the stream sets no cookie.
    expect(stream.response.headers.get('set-cookie')).toBeNull();

    // No stopwatch: a stream or socket left open would keep `close()` waiting past the test's timeout.
    await running.close();
    await stream.closed;
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  }, 20_000);

  it('a stream opened while the server drains (its request on the way when close() begins) does not hold close()', async () => {
    // The backend starts listening only when the test says so: the stream's request is inside the hub when the server closes.
    const memory = new MemoryLiveBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => (arrived = resolve));
    const slow: LiveBackend = {
      refresh: memory.refresh.bind(memory),
      end: memory.end.bind(memory),
      seqs: memory.seqs.bind(memory),
      close: memory.close.bind(memory),
      listen: async (listener) => {
        arrived();
        await gate;
        return memory.listen(listener);
      },
    };
    const app = await createApplication({
      root,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ServerServiceProvider, LiveServiceProvider],
      modules: [defineModule({ name: 'board', routes: openRoutes((Route) => void Route.get('/board', ShowBoardController)) })],
    }, { env: { APP_KEY: generateKey(), PORT: '1', SESSION_DRIVER: 'memory' }, override: (container: Container) => container.instance(LiveBackend, slow) });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/board`, { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
    const page = (await answer.json()) as PageObject;
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = page.live![0]!;
    const stream = fetch(`http://127.0.0.1:${port}/_marmeon/live?connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`, { headers: { accept: 'text/event-stream', cookie } });
    await waiting;
    const closed = running.close();
    release();
    const response = await stream;
    // The server closes by itself — not because the tab let go of a stream it got.
    const outcome = await Promise.race([closed.then(() => 'closed'), new Promise((resolve) => setTimeout(resolve, 3000, 'held'))]);
    await response.body?.cancel();
    await closed;
    expect(outcome).toBe('closed');
    expect(response.status).toBe(503);
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  }, 20_000);
});

describe('the memory backend and marmeon start --workers', () => {
  const fixture = fileURLToPath(new URL('./__fixtures__/cluster-boot.ts', import.meta.url));
  const run = (mode: string) => {
    const { NODE_OPTIONS: _options, MARMEON_CLUSTER_WORKER: _mark, ...env } = process.env;
    const mark = mode === 'single' ? { MARMEON_CLUSTER_WORKER: '1' } : {};
    const result = spawnSync(process.execPath, ['--conditions=@marmeon/source', fixture, root, mode], { cwd: dirname(fixture), encoding: 'utf8', env: { ...env, ...mark }, timeout: 20_000 });
    return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
  };

  it('a worker of a cluster does not start with LIVE_DRIVER=memory — hints would never reach the other workers', () => {
    expect(run('worker')).toEqual({
      code: 70,
      output:
        'failed: [marmeon:H7] LIVE_DRIVER=memory cannot serve marmeon start --workers: memory pub/sub never reaches the other workers — use LIVE_DRIVER=redis (with @marmeon/redis), or start one process without --workers.',
    });
  }, 30_000);

  it('one process starts with it — also with the workers\' mark left in its environment', () => {
    expect(run('single')).toEqual({ code: 0, output: 'booted' });
  }, 30_000);
});

describe("the live package's error lines", () => {
  it("mask a failing backend's error with the app's Redactor — the session cookie it quotes stays out of the log", async () => {
    const logged: unknown[] = [];
    const capture: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => void logged.push({ message, context }), child: () => capture };
    const leaky = new Error('the backend refused Cookie: a=1; marmeon_session=s3ss10nvalue');
    const memory = new MemoryLiveBackend();
    const failing: LiveBackend = {
      refresh: () => Promise.reject(leaky),
      end: () => Promise.reject(leaky),
      seqs: memory.seqs.bind(memory),
      listen: () => Promise.reject(leaky),
      close: memory.close.bind(memory),
    };
    const app = await createApplication({
      root,
      discover: false,
      // The session package adds its cookie's name to the app's Redactor at boot.
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, LiveServiceProvider],
    }, {
      env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' },
      override: (container) => {
        container.instance(LiveBackend, failing);
        container.instance(Logger, capture);
      },
    });
    await app.container.make(Broadcaster).refresh('users.1');
    expect((await app.container.make(LiveHub).open({ channels: ['users.1'], scope: 'scope-of-adas-session', connection: 'tab-a-0001' })).status).toBe(503);
    await app.container.make(SessionEndings).ended('scope-of-adas-session');
    expect(JSON.stringify(logged), JSON.stringify(logged)).not.toContain('s3ss10nvalue');
    const exception = 'Error: the backend refused Cookie: [redacted]; marmeon_session=[redacted]';
    expect(logged).toEqual([
      { message: 'A live hint on "users.1" could not be sent', context: { channel: 'users.1', exception } },
      { message: 'A live stream could not start (the live backend failed)', context: { exception } },
      { message: 'The streams of a session that ended could not be closed (the live backend failed)', context: { exception } },
    ]);
    await app.shutdown();
  });
});
