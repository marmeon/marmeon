import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { findLockfile, trustedTop } from './trusted-folders.ts';

const CORE = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'] as const;
const WITH_DENO = [...CORE, 'deno.lock'] as const;

/** `top` (0755) → `open` (0777) → `mid` (0755) → `app`; the folders are real paths, the open one is closed again after the test. */
function layout(): { top: string; open: string; mid: string; app: string } {
  const top = realpathSync.native(tempDir('marmeon-trusted-'));
  const open = join(top, 'open');
  const mid = join(open, 'mid');
  const app = join(mid, 'app');
  mkdirSync(app, { recursive: true });
  chmodSync(top, 0o755);
  chmodSync(mid, 0o755);
  chmodSync(open, 0o777);
  onTestFinished(() => chmodSync(open, 0o755));
  return { top, open, mid, app };
}

describe.skipIf(process.platform === 'win32')('trustedTop', () => {
  it('ends the way up below the first folder that everyone can write to', () => {
    const { mid, app } = layout();
    expect(trustedTop(app)).toBe(mid);
  });

  it('always accepts the app folder, also when its parent or it itself is writable by everyone', () => {
    const { mid, app } = layout();
    chmodSync(mid, 0o777);
    onTestFinished(() => chmodSync(mid, 0o755));
    expect(trustedTop(app)).toBe(app);
    chmodSync(app, 0o777);
    onTestFinished(() => chmodSync(app, 0o755));
    expect(trustedTop(app)).toBe(app);
  });
});

describe.skipIf(process.platform === 'win32')('findLockfile', () => {
  it('finds the nearest of two lockfiles within the bound', () => {
    const { mid, app } = layout();
    writeFileSync(join(mid, 'pnpm-lock.yaml'), '');
    writeFileSync(join(app, 'yarn.lock'), '');
    expect(findLockfile(app, CORE)).toBe(join(app, 'yarn.lock'));
  });

  it('finds a lockfile in the folder at the bound', () => {
    const { mid, app } = layout();
    writeFileSync(join(mid, 'pnpm-lock.yaml'), '');
    expect(findLockfile(app, CORE)).toBe(join(mid, 'pnpm-lock.yaml'));
  });

  it('finds no lockfile behind the folder that everyone can write to, nor in it', () => {
    const { top, open, app } = layout();
    writeFileSync(join(top, 'pnpm-lock.yaml'), '');
    expect(findLockfile(app, CORE)).toBeUndefined();
    writeFileSync(join(open, 'pnpm-lock.yaml'), '');
    expect(findLockfile(app, CORE)).toBeUndefined();
  });

  it('knows only the names the caller gives', () => {
    const { mid, app } = layout();
    writeFileSync(join(mid, 'deno.lock'), '');
    expect(findLockfile(app, CORE)).toBeUndefined();
    expect(findLockfile(app, WITH_DENO)).toBe(join(mid, 'deno.lock'));
  });

  it('finds nothing in an app whose parent everyone can write to, when the app holds no lockfile', () => {
    const { mid, app } = layout();
    chmodSync(mid, 0o777);
    onTestFinished(() => chmodSync(mid, 0o755));
    writeFileSync(join(mid, 'pnpm-lock.yaml'), '');
    expect(findLockfile(app, CORE)).toBeUndefined();
  });
});
