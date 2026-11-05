import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { unsafe, unsafePath } from './agents/files.ts';
import { readRegularIn } from './files.ts';

/**
 * `root/d` leads to `outside/sub`, and `root/evil` to `d/../x`: the system lands in `outside/x`, while a resolver that collapses
 * `d/..` before it follows `d` lands in `root/x` — a harmless file inside the app.
 */
function layout() {
  const base = realpathSync(tempDir('marmeon-native-realpath-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(join(outside, 'sub'), { recursive: true });
  writeFileSync(join(root, 'x'), 'inside');
  writeFileSync(join(outside, 'x'), 'outside');
  symlinkSync(join('..', 'outside', 'sub'), join(root, 'd'));
  symlinkSync('d/../x', join(root, 'evil'));
  return { root, outside };
}

describe('containment follows a link the way the system does', () => {
  it('agents:install refuses to write through a link that lands outside the app', () => {
    const { root } = layout();
    expect(unsafePath(root, join(root, 'evil'))).toMatch(/outside the app/);
    expect(unsafe(root, join(root, 'evil'))).toMatch(/outside the app/);
  });

  it('readRegularIn does not read a file the link leads out of the root to', () => {
    const { root } = layout();
    expect(readRegularIn(root, 'evil')).toBeUndefined();
    expect(readRegularIn(root, 'x')?.text).toBe('inside');
  });
});
