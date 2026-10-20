import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { installRoot, workspaceRoot } from './workspace.ts';

/** A temp tree with an app at `apps/app`; `files` maps a path below the tree to its content. Paths are real. */
function tree(files: Record<string, string>): { base: string; app: string } {
  const base = realpathSync.native(tempDir('marmeon-workspace-'));
  const app = join(base, 'apps', 'app');
  mkdirSync(app, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return { base, app };
}

describe('workspaceRoot', () => {
  it('is the app root when the app has its lockfile, whatever lies above', () => {
    const { app } = tree({ 'apps/app/pnpm-lock.yaml': '', 'pnpm-workspace.yaml': '', 'pnpm-lock.yaml': '' });
    expect(installRoot(app)).toBe(app);
    expect(workspaceRoot(app)).toBe(app);
  });

  it('is the root with the lockfile and a pnpm-workspace.yaml above the app', () => {
    const { app, base } = tree({ 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': 'packages:\n  - apps/*\n' });
    expect(workspaceRoot(app)).toBe(base);
  });

  it('is the root when its package.json lists workspaces, as an array or as an object with packages', () => {
    for (const workspaces of [['apps/*'], { packages: ['apps/*'] }]) {
      const { app, base } = tree({ 'package-lock.json': '', 'package.json': JSON.stringify({ workspaces }) });
      expect(workspaceRoot(app)).toBe(base);
    }
  });

  it('is the app root when only a lockfile lies above', () => {
    const { app, base } = tree({ 'yarn.lock': '' });
    expect(installRoot(app)).toBe(base);
    expect(workspaceRoot(app)).toBe(app);
  });

  it('is the app root without a lockfile anywhere', () => {
    const { app } = tree({ 'pnpm-workspace.yaml': '' });
    expect(workspaceRoot(app)).toBe(app);
  });

  it('reads a package.json that does not parse as no declaration', () => {
    const { app } = tree({ 'pnpm-lock.yaml': '', 'package.json': '{ "workspaces": [' });
    expect(workspaceRoot(app)).toBe(app);
  });

  it('knows the lockfiles of Bun and Deno', () => {
    for (const lockfile of ['bun.lockb', 'deno.lock']) {
      const { app, base } = tree({ [lockfile]: '', 'pnpm-workspace.yaml': '' });
      expect(workspaceRoot(app)).toBe(base);
    }
  });

  it.skipIf(process.platform === 'win32')('is the app root when the directory above is writable by everyone', () => {
    const { app, base } = tree({ 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': '' });
    chmodSync(base, 0o777);
    expect(workspaceRoot(app)).toBe(app);
    chmodSync(base, 0o755);
    expect(workspaceRoot(app)).toBe(base);
  });

  it.skipIf(process.platform === 'win32')('ends the way up at the app when the first lockfile lies in a directory writable by everyone', () => {
    const { app, base } = tree({ 'pnpm-lock.yaml': '' });
    chmodSync(base, 0o777);
    expect(installRoot(app)).toBe(app);
    chmodSync(base, 0o755);
    expect(installRoot(app)).toBe(base);
  });
});
