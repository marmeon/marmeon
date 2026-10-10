import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { AfterResponse, defineRoutes, HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { startServer } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('marmeon-drain-');
writeFileSync(join(root, 'index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
writeFileSync(join(root, 'ssr.ts'), 'export const render = async () => ({ html: "" });');
mkdirSync(join(root, 'node_modules'));
symlinkSync(dirname(createRequire(import.meta.url).resolve('vite/package.json')), join(root, 'node_modules/vite'), 'dir');

/** Defers work after its response: 300 ms of "sending a mail", or work that never ends. */
const done: string[] = [];
class DeferController {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(async () => {
      await sleep(300);
      done.push('mail');
    });
    return { ok: true };
  }
}
class HangController {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => new Promise(() => {}));
    return { ok: true };
  }
}

const FIXTURE = fileURLToPath(new URL('./__fixtures__/drain-server.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

// Stopping the server must not lose the work its requests deferred until after their response — the app's
// shutdown closes the pools that work needs, so `close()` waits for it first.
describe('stopping the server', () => {
  it('lets work after the response finish before close() returns', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey() },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [
        defineModule({
          name: 'deferred',
          apiRoutes: defineRoutes((Route) => Route.post('/work', DeferController)),
        }),
      ],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/api/work`, { method: 'POST' })).status).toBe(200);
    await running.close();
    expect(done).toEqual(['mail']);
    await app.shutdown();
  });

  it('gives up on work that hangs after the drain timeout', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey() },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [
        defineModule({
          name: 'hanging',
          apiRoutes: defineRoutes((Route) => Route.post('/hang', HangController)),
        }),
      ],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development', drainTimeoutMs: 200 });
    const { port } = running.server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/api/hang`, { method: 'POST' });
    const started = performance.now();
    await running.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    await app.shutdown();
  });

  it('SHUTDOWN_DELAY: /up/ready 503 at once, requests still answered for the delay (connection: close), then the drain', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), SHUTDOWN_DELAY: '0.6' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [defineModule({ name: 'hello', apiRoutes: defineRoutes((Route) => void Route.get('/hello', () => ({ hello: true }))) })],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const { port } = running.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/up/ready`)).status).toBe(200);
    const started = performance.now();
    const closed = running.close();
    // Not ready from the signal on — the load balancer's next probe sends traffic elsewhere — but still answering.
    const ready = await fetch(`${base}/up/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'draining' });
    expect((await fetch(`${base}/up`)).status).toBe(200);
    await sleep(300);
    const late = await fetch(`${base}/api/hello`);
    expect(late.status).toBe(200);
    expect(late.headers.get('connection')).toBe('close');
    await closed;
    expect(performance.now() - started).toBeGreaterThanOrEqual(590);
    await expect(fetch(`${base}/up`)).rejects.toThrow();
    await app.shutdown();
  });

  it('close({ immediately: true }) skips the delay (Ctrl+C)', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), SHUTDOWN_DELAY: '5' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    });
    const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode: 'development' });
    const started = performance.now();
    await running.close({ immediately: true });
    expect(performance.now() - started).toBeLessThan(2_000);
    await app.shutdown();
    await expect(
      createApplication({ root, discover: false, env: { APP_KEY: generateKey(), SHUTDOWN_DELAY: '5s' }, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] }),
    ).rejects.toThrow('Expected seconds, like 5 or 0.5');
  });

  it('sends the mail of a request answered just before SIGTERM, then exits (as `marmeon serve` stops)', { timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, ['--conditions=@marmeon/source', FIXTURE, root], { cwd: PACKAGE, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let errors = '';
    child.stderr!.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    const listening = new Promise<number>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        lines.push(line);
        const match = /^listening (\d+)$/.exec(line);
        if (match) resolve(Number(match[1]));
      });
      child.once('exit', () => reject(new Error(`The server did not start: ${errors}`)));
    });
    const port = await listening;
    expect((await fetch(`http://127.0.0.1:${port}/api/reset`, { method: 'POST' })).status).toBe(200);
    child.kill('SIGTERM'); // the response is out, the mail not yet
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(errors).not.toMatch(/Deferred work failed/);
    expect(lines.filter((line) => line === 'sent reset link' || line === 'shutdown')).toEqual(['sent reset link', 'shutdown']);
    expect(code).toBe(0);
  });
});
