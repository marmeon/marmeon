import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const app = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../../../../packages/cli/bin/marmeon.js', import.meta.url));

// The app shows `marmeon modules:list`: its modules with every part of the document, the packages it discovered and the
// listeners of its events — read without booting the app.
it('lists the modules of the app, each with all seven keys, and the packages and events', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST') delete env[key];
  const result = spawnSync(process.execPath, [cli, 'modules:list', '--json'], { cwd: app, env, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  const document = JSON.parse(result.stdout) as {
    format: number;
    packages: string[];
    modules: { name: string }[];
    events: { event: string; listeners: unknown[] }[];
  };
  expect(document.format).toBe(1);
  expect(document.packages).toContain('@marmeon/http');
  expect(document.modules.map((module) => module.name)).toEqual(expect.arrayContaining(['auth', 'system', 'notifications', 'webhooks']));
  for (const module of document.modules) {
    expect(Object.keys(module)).toEqual(['name', 'providers', 'commands', 'jobs', 'notifications', 'seeders', 'migrations']);
  }
  expect(document.events.length).toBeGreaterThan(0);
  expect(document.events.every((entry) => entry.listeners.length > 0)).toBe(true);
});
