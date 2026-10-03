import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type PageObject } from '@bespokecore/http';
import { ServerServiceProvider, startServer } from '@bespokecore/server';
import { SessionServiceProvider } from '@bespokecore/session';
import { afterAll, describe, expect, it } from 'vitest';
import { LiveServiceProvider } from './index.ts';
import { LiveStreamReader } from './test-stream.ts';

const root = mkdtempSync(join(tmpdir(), 'bespoke-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
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
    const running = await startServer({ app, ssrEntry: 'ssr.ts', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const answer = await fetch(`http://localhost:${port}/board`, { headers: { 'x-bespoke': 'true' } });
    const page = (await answer.json()) as PageObject;
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = page.live![0]!;
    const stream = new LiveStreamReader(
      await fetch(`http://localhost:${port}/_bespoke/live?connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`, { headers: { accept: 'text/event-stream', cookie } }),
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
});
