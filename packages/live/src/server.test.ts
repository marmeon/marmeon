import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, defineModule, type Container } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type PageObject } from '@bespokecore/http';
import { ServerServiceProvider, startServer } from '@bespokecore/server';
import { SessionServiceProvider } from '@bespokecore/session';
import { describe, expect, it } from 'vitest';
import { LiveBackend, LiveServiceProvider, MemoryLiveBackend } from './index.ts';
import { LiveStreamReader } from './test-stream.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('bespoke-live-');
writeFileSync(join(root, 'index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
writeFileSync(join(root, 'ssr.ts'), 'export const render = async () => ({ html: "" });');
mkdirSync(join(root, 'node_modules'));
symlinkSync(dirname(createRequire(import.meta.url).resolve('vite/package.json')), join(root, 'node_modules/vite'), 'dir');

class ShowBoardController extends Controller {
  handle() {
    return this.view('board/Show', { cards: [] }).live('board.1');
  }
}

describe('a live stream and the server (E104)', () => {
  it('startServer().close() ends the open streams — it is not held up by a tab that never goes away', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1', SESSION_DRIVER: 'memory' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ServerServiceProvider, LiveServiceProvider],
      modules: [defineModule({ name: 'board', routes: defineRoutes((Route) => void Route.get('/board', ShowBoardController)) })],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/board`, { headers: { 'x-bespoke': 'true' } });
    const page = (await answer.json()) as PageObject;
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = page.live![0]!;
    const stream = new LiveStreamReader(
      await fetch(`http://127.0.0.1:${port}/_bespoke/live?connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`, { headers: { accept: 'text/event-stream', cookie } }),
    );
    expect(await stream.hello()).toEqual({ seq: { 'board.1': 0 } });
    // Read-only: the stream sets no cookie.
    expect(stream.response.headers.get('set-cookie')).toBeNull();

    const started = performance.now();
    await running.close();
    expect(performance.now() - started).toBeLessThan(2000);
    await stream.closed;
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  }, 20_000);

  it('a stream opened while the server drains (its request on the way when close() begins) does not hold close() (W9 step 4)', async () => {
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
      env: { APP_KEY: generateKey(), PORT: '1', SESSION_DRIVER: 'memory' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ServerServiceProvider, LiveServiceProvider],
      modules: [defineModule({ name: 'board', routes: defineRoutes((Route) => void Route.get('/board', ShowBoardController)) })],
      override: (container: Container) => container.instance(LiveBackend, slow),
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/board`, { headers: { 'x-bespoke': 'true' } });
    const page = (await answer.json()) as PageObject;
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = page.live![0]!;
    const stream = fetch(`http://127.0.0.1:${port}/_bespoke/live?connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`, { headers: { accept: 'text/event-stream', cookie } });
    await waiting;
    const closed = running.close();
    release();
    const response = await stream;
    // The server closes by itself — not because the tab let go of a stream it got (the old code: held until the hard exit).
    const outcome = await Promise.race([closed.then(() => 'closed'), new Promise((resolve) => setTimeout(resolve, 3000, 'held'))]);
    await response.body?.cancel();
    await closed;
    expect(outcome).toBe('closed');
    expect(response.status).toBe(503);
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  }, 20_000);
});

describe('the memory backend and bespoke start --workers (W9 step 4)', () => {
  const fixture = fileURLToPath(new URL('./__fixtures__/cluster-boot.ts', import.meta.url));
  const run = (mode: string) => {
    const { NODE_OPTIONS: _options, BESPOKE_CLUSTER_WORKER: _mark, ...env } = process.env;
    const mark = mode === 'single' ? { BESPOKE_CLUSTER_WORKER: '1' } : {};
    const result = spawnSync(process.execPath, ['--conditions=@bespokecore/source', fixture, root, mode], { cwd: dirname(fixture), encoding: 'utf8', env: { ...env, ...mark }, timeout: 20_000 });
    return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
  };

  it('a worker of a cluster does not start with LIVE_DRIVER=memory — hints would never reach the other workers', () => {
    expect(run('worker')).toEqual({
      code: 70,
      output:
        'failed: LIVE_DRIVER=memory cannot serve bespoke start --workers: memory pub/sub never reaches the other workers — use LIVE_DRIVER=redis (with @bespokecore/redis), or start one process without --workers.',
    });
  }, 30_000);

  it('one process starts with it — also with the workers\' mark left in its environment', () => {
    expect(run('single')).toEqual({ code: 0, output: 'booted' });
  }, 30_000);
});
