import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { bin } from './__fixtures__/cli.js';

/**
 * Runs `marmeon <args>` with the read end of `closed` ('stdout', 'stderr' or both) closed right after the start, as when a reader like
 * `head` has gone: the child's first write to it fails with EPIPE, whatever the size of the output.
 */
function run(args: string[], closed: ('stdout' | 'stderr')[]): Promise<{ code: number | null; stderr: string }> {
  const { MARMEON_CHILD: _child, ...parent } = process.env;
  const child = spawn(process.execPath, [bin, ...args], { cwd: tempDir('marmeon-pipe-'), env: { ...parent, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  if (!closed.includes('stderr')) child.stderr.setEncoding('utf8').on('data', (text: string) => void (stderr += text));
  for (const name of closed) child[name].destroy();
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

describe('a reader that has closed the pipe', () => {
  it.each([['docs'], ['list'], ['help']])('lets marmeon %s end without an error', async (command) => {
    const { code, stderr } = await run([command], ['stdout']);
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toMatch(/\bat \S+ \(/);
    expect(code).toBe(0);
  }, 30_000);

  it('leaves the exit code of a command that fails', async () => {
    // Exit code 2 (an unknown page), whether stdout, stderr or both are closed.
    for (const closed of [['stdout'], ['stderr'], ['stdout', 'stderr']] as const) {
      const { code, stderr } = await run(['docs', '../package'], [...closed]);
      expect(code, closed.join('+')).toBe(2);
      expect(stderr).not.toContain('EPIPE');
    }
  }, 30_000);
});
