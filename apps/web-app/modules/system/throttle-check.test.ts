import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const app = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../../../../packages/cli/bin/marmeon.js', import.meta.url));

// The app shows what `marmeon check` asks of every app: a route anyone may POST to has a limit.
// `marmeon check` boots the whole app in a child process and runs its checks: that is the work this timeout is for.
it('limits every route that anyone may POST to', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST') delete env[key];
  const result = spawnSync(process.execPath, [cli, 'check', '--only=throttle', '--json'], { cwd: app, env, encoding: 'utf8' });
  expect(JSON.parse(result.stdout)).toMatchObject({ checks: [{ name: 'throttle', status: 'passed', problems: [], silenced: [] }] });
  expect(result.status).toBe(0);
});
