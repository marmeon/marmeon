import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './temp-dir.js';

const fake = vi.hoisted(() => ({ skip: 0 }));

// Stands in for the silent Linux behaviour: `rmSync` returns without an error and leaves the directory.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      if (fake.skip > 0) {
        fake.skip--;
        return;
      }
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
  };
});

describe('tempDir', () => {
  let made = '';

  it('makes a directory', () => {
    made = tempDir('marmeon-temp-dir-');
    expect(existsSync(made)).toBe(true);
    fake.skip = 2;
  });

  it('removed it although rmSync returned without removing it', () => {
    expect(fake.skip).toBe(0);
    expect(existsSync(made)).toBe(false);
  });

  let stuck = '';

  // `it.fails` expects the failure that `remove` throws from `onTestFinished` when every attempt leaves the directory.
  it.fails('throws when the directory is still there after every attempt', () => {
    stuck = tempDir('marmeon-temp-dir-');
    fake.skip = 3;
  });

  it('left that directory in place', () => {
    expect(existsSync(stuck)).toBe(true);
    rmSync(stuck, { recursive: true, force: true });
    expect(existsSync(stuck)).toBe(false);
  });
});
