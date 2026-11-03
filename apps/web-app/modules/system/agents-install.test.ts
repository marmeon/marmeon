import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const app = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../../../../packages/cli/bin/marmeon.js', import.meta.url));

// The app shows the installation of the framework's skills and keeps it current: a changed skill in the package asks for new
// copies here (`pnpm --filter web-app exec marmeon agents:install`), the way `db:types --check` asks for new table types.
it('has the skills and the MCP entry that agents:install writes, current', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST') delete env[key];
  const result = spawnSync(process.execPath, [cli, 'agents:install', '--check'], { cwd: app, env, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('The skills and the entry in .mcp.json are current.');
  expect(result.status).toBe(0);
});
