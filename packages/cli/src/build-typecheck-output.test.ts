import { afterEach, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BuildCommand } from './commands/build.ts';
import { Output } from './output.ts';

vi.mock('./typecheck.ts', () => ({
  // tsc colours its output on a terminal; the file name in it is the app's own text.
  typecheckApp: async () => ({ status: 'failed', output: '\x1b[96msrc/a\u202e.ts\x1b[0m:\x1b]52;c;aGk=\x07 error', errors: 1, files: 1 }),
}));

afterEach(() => vi.restoreAllMocks());

it('prints the output of tsc with its colours and without what steers a terminal', async () => {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => void written.push(text)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const code = await new BuildCommand().handle({ args: [], options: {}, output: new Output(), root: tempDir('marmeon-build-'), spawn: async () => 0 } as never);
  expect(code).toBe(1);
  const text = written.join('');
  expect(text).toContain('\x1b[96msrc/a\\u202e.ts\x1b[0m:\\u001b]52;c;aGk=\\u0007 error');
});
