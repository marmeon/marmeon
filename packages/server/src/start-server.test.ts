import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createApplication, defineModule, Logger } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, HttpServiceProvider } from '@marmeon/http';
import { RouteAccessError } from '@marmeon/router';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from './kernel.ts';
import { createViteDevRenderer } from './vite.ts';
import { ServerServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// A spy that runs the real thing: the refused start below must never reach it.
vi.mock('./vite.ts', async (original) => {
  const actual = await original<typeof import('./vite.ts')>();
  return { ...actual, createViteDevRenderer: vi.fn(actual.createViteDevRenderer) };
});

const root = tempDir('marmeon-serve-');
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
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;

    // An open tab: Vite's HMR socket (an upgraded connection) plus an idle keep-alive connection.
    const hmr = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr');
    await new Promise((resolve, reject) => {
      hmr.onopen = resolve;
      hmr.onerror = reject;
    });
    const hmrClosed = new Promise((resolve) => (hmr.onclose = resolve));
    expect((await fetch(`http://127.0.0.1:${port}/nope`, { headers: { connection: 'keep-alive' } })).status).toBe(404);

    const started = performance.now();
    await running.close();
    expect(performance.now() - started).toBeLessThan(2000);
    await hmrClosed;
    expect(running.server.listening).toBe(false);
    await app.shutdown();
  });

  it('answers no other origin in development — Vite\'s CORS is off (a page on another localhost port reads nothing)', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    try {
      for (const path of ['/nope', '/@vite/client']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin: 'http://localhost:5555' } });
        await response.arrayBuffer();
        expect(response.headers.get('access-control-allow-origin'), `${path} answered another origin`).toBeNull();
      }
      const preflight = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5555', 'access-control-request-method': 'GET' } });
      await preflight.arrayBuffer();
      expect(preflight.headers.get('access-control-allow-origin'), 'a preflight was allowed').toBeNull();
    } finally {
      await running.close();
      await app.shutdown();
    }
  });

  describe('a program holding the port on 127.0.0.1', () => {
    /** A decoy: another program on 127.0.0.1 only, at a port the system picked. */
    const decoy = async (): Promise<{ program: NetServer; port: number }> => {
      const program = createNetServer((socket) => socket.end('HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\n\r\n'));
      await new Promise<void>((resolve) => program.listen(0, '127.0.0.1', resolve));
      return { program, port: (program.address() as AddressInfo).port };
    };
    const boot = async () => {
      const app = await createApplication({
        root,
        discover: false,
        env: { APP_KEY: generateKey(), PORT: '1' },
        providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      });
      const warned: string[] = [];
      vi.spyOn(app.container.make(Logger), 'warn').mockImplementation((message: unknown) => void warned.push(String(message)));
      return { app, warned };
    };

    it('on every interface (no HOST, `::`, `0.0.0.0`) the start says so — requests to 127.0.0.1 would reach that program', async () => {
      for (const host of [undefined, '::', '0.0.0.0']) {
        const { program, port } = await decoy();
        const { app, warned } = await boot();
        try {
          // macOS lets the server listen beside the program; elsewhere the start fails — after the same warning.
          const running = await startServer({ app, ssrEntry: 'ssr.ts', host, port, mode: 'development' }).catch((error: NodeJS.ErrnoException) => {
            expect(error.code).toBe('EADDRINUSE');
            return undefined;
          });
          await running?.close();
          expect(warned.join('\n'), `HOST ${host}: no warning`).toContain(`Another program holds 127.0.0.1:${port} — this server listens on every interface`);
        } finally {
          program.close();
          await app.shutdown();
        }
      }
    });

    it('says nothing when the port is free there — and a chosen interface that is taken fails the start with Node\'s error', async () => {
      const { program, port } = await decoy();
      const { app, warned } = await boot();
      try {
        await expect(startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port, mode: 'development' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
        program.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const running = await startServer({ app, ssrEntry: 'ssr.ts', port, mode: 'development' });
        await running.close();
        expect(warned).toEqual([]);
      } finally {
        program.close();
        await app.shutdown();
      }
    });
  });

  it('runs Vite\'s dev server only with NODE_ENV=development — test or no NODE_ENV serve the build, any other value does not start', async () => {
    const before = process.env.NODE_ENV;
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    });
    try {
      // An unknown NODE_ENV — set after the app booted — never serves: the start error, before any mode is chosen.
      process.env.NODE_ENV = 'staging';
      await expect(startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0 })).rejects.toThrow(/NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging/);
      for (const nodeEnv of ['test', 'production', undefined]) {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        // The production renderer: this root has no build — so no Vite, no source modules, no `/__open-in-editor`.
        await expect(startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0 }), `NODE_ENV=${nodeEnv}`).rejects.toThrow(/No production build/);
      }
      process.env.NODE_ENV = 'development';
      const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0 });
      const { port } = running.server.address() as AddressInfo;
      expect((await fetch(`http://127.0.0.1:${port}/@vite/client`)).status).toBe(200);
      await running.close();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      await app.shutdown();
    }
  });

  it('refuses to start in development when a route does not say who may call it — before Vite starts, so nothing is left running', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), PORT: '1' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [defineModule({ name: 'pages', routes: defineRoutes((Route) => Route.get('/about', () => 'about')) })],
    });
    vi.mocked(createViteDevRenderer).mockClear();
    try {
      await expect(startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' })).rejects.toBeInstanceOf(RouteAccessError);
      expect(createViteDevRenderer).not.toHaveBeenCalled();
    } finally {
      await app.shutdown();
    }
  });
});
