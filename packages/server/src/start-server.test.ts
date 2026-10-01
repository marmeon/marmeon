import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApplication } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { HttpServiceProvider } from '@bespokecore/http';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';

const root = mkdtempSync(join(tmpdir(), 'bespoke-serve-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
writeFileSync(join(root, 'ssr.ts'), 'export const render = async () => ({ html: "" });');
// The app's own Vite (an optional peer of the server); no vite.config.ts, so the SSR entry is passed explicitly.
mkdirSync(join(root, 'node_modules'));
symlinkSync(dirname(createRequire(import.meta.url).resolve('vite/package.json')), join(root, 'node_modules/vite'), 'dir');

describe('startServer', () => {
  it('closes in development although a browser tab holds the HMR WebSocket and a keep-alive connection', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;

    // An open tab: Vite's HMR socket (an upgraded connection) plus an idle keep-alive connection.
    const hmr = new WebSocket(`ws://localhost:${port}/`, 'vite-hmr');
    await new Promise((resolve, reject) => {
      hmr.onopen = resolve;
      hmr.onerror = reject;
    });
    const hmrClosed = new Promise((resolve) => (hmr.onclose = resolve));
    expect((await fetch(`http://localhost:${port}/nope`, { headers: { connection: 'keep-alive' } })).status).toBe(404);

    const started = performance.now();
    await running.close();
    expect(performance.now() - started).toBeLessThan(2000);
    await hmrClosed;
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  });
});
