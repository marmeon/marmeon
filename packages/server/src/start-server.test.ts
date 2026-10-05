import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { createApplication } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { HttpServiceProvider } from '@bespokecore/http';
import { describe, expect, it } from 'vitest';
import { startServer } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('bespoke-serve-');
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

  it('runs Vite\'s dev server only with NODE_ENV=development — staging, test or no NODE_ENV serve the build (E115)', async () => {
    const before = process.env.NODE_ENV;
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    });
    try {
      for (const nodeEnv of ['staging', 'test', 'production', undefined]) {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        // The production renderer: this root has no build — so no Vite, no source modules, no `/__open-in-editor`.
        await expect(startServer({ app, ssrEntry: 'ssr.ts', port: 0 }), `NODE_ENV=${nodeEnv}`).rejects.toThrow(/No production build/);
      }
      process.env.NODE_ENV = 'development';
      const running = await startServer({ app, ssrEntry: 'ssr.ts', port: 0 });
      const { port } = running.server.address() as AddressInfo;
      expect((await fetch(`http://localhost:${port}/@vite/client`)).status).toBe(200);
      await running.close();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      await app.shutdown();
    }
  });
});
