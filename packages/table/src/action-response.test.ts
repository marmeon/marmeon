import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { startServer } from '@marmeon/server';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { ByEmailTable, DeactivateByEmail, endpoint, tableApp } from './__fixtures__/app.ts';

let root: string;
beforeAll(() => {
  root = tempDir('marmeon-table-response-');
  for (const dir of ['dist/client', 'dist/server']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/client/index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
});
afterEach(() => void vi.restoreAllMocks());

async function afterStart<T>(act: (table: Awaited<ReturnType<typeof tableApp>>) => Promise<T>): Promise<T> {
  const table = await tableApp('sqlite', { root });
  // For the adapter's global Response, which startServer installs.
  const running = await startServer({ app: table.application, host: '127.0.0.1', port: 0, mode: 'production' });
  try {
    return await act(table);
  } finally {
    await running.close({ immediately: true });
    await table.close();
  }
}

const deactivate = (table: Awaited<ReturnType<typeof tableApp>>) => table.request(endpoint(ByEmailTable, 'action', 'deactivate'), { method: 'POST', user: 1, json: { key: 'edsger@example.com' } });

it("an action that returns a Response of its own answers it, also a clone", async () => {
  await afterStart(async (table) => {
    vi.spyOn(DeactivateByEmail.prototype, 'handle').mockImplementation(() => new Response('OWN', { status: 418 }).clone() as never);
    const response = await deactivate(table);
    expect([response.status, await response.text()]).toEqual([418, 'OWN']);
  });
});

it("an action that returns a Response of fetch() is refused with a 500, not answered with its counts or its body", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'set-cookie': 'upstream=1' });
    response.end('UPSTREAM');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const held = await fetch(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`);
    await afterStart(async (table) => {
      vi.spyOn(DeactivateByEmail.prototype, 'handle').mockImplementation(() => held as never);
      const response = await deactivate(table);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"message":"marmeon.status.500"}');
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
