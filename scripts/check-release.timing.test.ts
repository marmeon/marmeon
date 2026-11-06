import { describe, expect, it } from 'vitest';
import { movesTheTree } from './check-release.ts';

/** A workflow in a pull request can be anything: the check of its commands may not take time that grows faster than the line. */
describe('check:release — the tree-moving commands are found in linear time', () => {
  it.each([
    ['many options', `git ${'-! '.repeat(100_000)}`],
    ['many options before a command', `git ${'-! '.repeat(100_000)}checkout`],
    ['many git words', 'git '.repeat(100_000)],
    ['overlapping starts', `echo ${'git -! '.repeat(50_000)}`],
  ])('%s', (_name, text) => {
    const start = performance.now();
    movesTheTree(text);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
