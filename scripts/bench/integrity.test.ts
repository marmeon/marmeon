import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.js';
import { ensureImportable, importProblem, removeNodeModules } from './integrity.ts';

/**
 * The bench's checkouts are smoke-tested before a run (W8.13: a snapshot under $TMPDIR lost files of its node_modules, and the run
 * died with ERR_MODULE_NOT_FOUND). A fixture checkout with one installed package stands in for a worktree.
 */
function checkout(): string {
  const dir = tempDir('marmeon-bench-fixture-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
  installDependency(dir);
  mkdirSync(join(dir, 'packages/a/node_modules/x'), { recursive: true });
  return dir;
}

function installDependency(dir: string, source = 'export const ok = true;\n'): void {
  mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', type: 'module', exports: './index.js' }));
  writeFileSync(join(dir, 'node_modules/dep/index.js'), source);
}

const probe = (dir: string) => ({ cwd: dir, specifiers: ['dep'] });

describe('pnpm bench — a checkout is importable before it is measured', () => {
  it('a healthy checkout is left alone', () => {
    const dir = checkout();
    const installs: string[] = [];
    ensureImportable(dir, probe(dir), { install: (at) => installs.push(at), log: () => {} });
    expect(installs).toEqual([]);
    expect(existsSync(join(dir, 'packages/a/node_modules/x'))).toBe(true);
  });

  it('damaged node_modules (a file gone) are removed — every one of them — and installed again, instead of ERR_MODULE_NOT_FOUND mid-run', () => {
    const dir = checkout();
    rmSync(join(dir, 'node_modules/dep/index.js'));
    expect(importProblem(probe(dir))).toMatch(/ERR_MODULE_NOT_FOUND/);
    const seen: { root: boolean; workspace: boolean }[] = [];
    const lines: string[] = [];
    ensureImportable(dir, probe(dir), {
      install: (at) => {
        seen.push({ root: existsSync(join(at, 'node_modules')), workspace: existsSync(join(at, 'packages/a/node_modules')) });
        installDependency(at);
      },
      log: (line) => lines.push(line),
    });
    expect(seen).toEqual([{ root: false, workspace: false }]);
    expect(lines.join('\n')).toContain('removing them and installing again');
    expect(importProblem(probe(dir))).toBeUndefined();
  });

  it('a damage a fresh install does not fix, or a failure that is no missing module, stops the run', () => {
    const dir = checkout();
    rmSync(join(dir, 'node_modules/dep/index.js'));
    expect(() => ensureImportable(dir, probe(dir), { install: () => {}, log: () => {} })).toThrow(/still cannot import what the measurement needs after a fresh install/);
    const broken = checkout();
    installDependency(broken, 'export const = ;\n');
    let installed = false;
    expect(() => ensureImportable(broken, probe(broken), { install: () => (installed = true), log: () => {} })).toThrow(/SyntaxError/);
    expect(installed).toBe(false);
  });

  it('removeNodeModules takes the root and every workspace package', () => {
    const dir = checkout();
    mkdirSync(join(dir, 'apps/web/node_modules'), { recursive: true });
    removeNodeModules(dir);
    expect(['node_modules', 'packages/a/node_modules', 'apps/web/node_modules'].filter((path) => existsSync(join(dir, path)))).toEqual([]);
    expect(existsSync(join(dir, 'packages/a'))).toBe(true);
  });
});
