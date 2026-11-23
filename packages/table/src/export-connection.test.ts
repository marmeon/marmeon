import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sql } from '@marmeon/database';
import { Encrypter } from '@marmeon/encryption';
import { startServer } from '@marmeon/server';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { ActiveTable, endpoint, tableApp } from './__fixtures__/app.ts';

let root: string;
beforeAll(() => {
  root = tempDir('marmeon-table-connection-');
  for (const dir of ['dist/client', 'dist/server']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/client/index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// SQLite only: its failed query settles within the adapter's reads before the headers, which is the case here.
it('an export whose second batch fails sends no text of the error', async () => {
  const table = await tableApp('sqlite', { root });
  cleanups.push(() => table.close());
  // More than one batch of 500.
  await table.insert(
    Array.from({ length: 600 }, (_, at) => ({ id: 1000 + at, team_id: 1, name: `Member ${at}`, email: `member-${at}@example.com`, role: 'member', created_at: '2026-01-10 09:00:00', last_seen_at: null })) as never,
  );
  const encrypter = table.application.container.make(Encrypter);
  const decrypt = encrypter.decrypt.bind(encrypter);
  // The cursor is decrypted at the start of the second batch and at no time before: the table is gone for exactly that query.
  const secondBatch = vi.spyOn(encrypter, 'decrypt').mockImplementation(async (...args: Parameters<typeof decrypt>) => {
    await sql`drop table members`.execute(table.connections.get());
    return decrypt(...args);
  });

  const running = await startServer({ app: table.application, host: '127.0.0.1', port: 0, mode: 'production' });
  cleanups.push(() => running.close({ immediately: true }));
  const socket = connect((running.server.address() as AddressInfo).port, '127.0.0.1');
  cleanups.push(() => socket.destroy());
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (data) => (received += data.toString('latin1')));
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write(`GET ${endpoint(ActiveTable, 'export', 'csv')} HTTP/1.1\r\nhost: localhost\r\nx-test-user: 1\r\n\r\n`);
  await closed;

  expect(secondBatch).toHaveBeenCalled();
  expect(received).toMatch(/^HTTP\/1\.1 500 /);
  expect(received).not.toContain('no such table');
  expect(received).not.toContain('Error:');
});
