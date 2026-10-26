import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const CLI = fileURLToPath(new URL('../../cli/bin/marmeon.js', import.meta.url));
const APP = fileURLToPath(new URL('./__fixtures__/app/', import.meta.url));

function marmeon(...args: string[]) {
  const directory = tempDir('marmeon-schedule-exit-');
  const result = spawnSync(process.execPath, ['--conditions=@marmeon/source', CLI, ...args], {
    cwd: APP,
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      NO_COLOR: '1',
      APP_NAME: 'Scheduler Fixture',
      DB_MANAGED: 'false',
      DB_DRIVER: 'sqlite',
      DB_DATABASE: join(directory, 'app.sqlite'),
      CACHE_DRIVER: 'memory',
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// An argument the command refuses is a wrong call (2), as for every command; a scheduler that fails is 1.
describe('exit codes of the schedule commands', { timeout: 30_000 }, () => {
  it('schedule:work --stop-timeout=x exits with 2 and says why on stderr', () => {
    const result = marmeon('schedule:work', '--stop-timeout=x');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--stop-timeout must be a number of seconds ≥ 0, not x.');
  });

  it('schedule:test without a name exits with 2 and lists the tasks', () => {
    const result = marmeon('schedule:test');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Which task? marmeon schedule:test <name>');
  });

  it('schedule:test with an unknown name exits with 2', () => {
    const result = marmeon('schedule:test', 'no-such-task');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no-such-task');
  });
});
