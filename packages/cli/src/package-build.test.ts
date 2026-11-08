import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PackageBuildCommand } from './commands/package-build.ts';
import { noPrompt } from './prompt.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const silent = { line: () => {}, success: () => {}, error: () => {}, info: () => {}, warn: () => {}, table: () => {} };

/** A package outside the repository: one source, TypeScript linked in, and the leftovers of an earlier build. */
function fixture(outDir = 'dist'): string {
  const dir = realpathSync(tempDir('marmeon-package-build-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(realpathSync(join(repo, 'node_modules/typescript')), join(dir, 'node_modules/typescript'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { composite: true, rootDir: 'src', outDir, module: 'NodeNext', target: 'ESNext', types: [] }, include: ['src'] }),
  );
  writeFileSync(join(dir, 'src/kept.ts'), 'export const kept = 1;\n');
  return dir;
}

function build(dir: string, options: Record<string, boolean> = {}) {
  return new PackageBuildCommand().handle({ args: [dir], options, output: silent as never, root: dir, spawn: async () => 0, prompt: noPrompt });
}

describe('marmeon package:build --clean', () => {
  let dir: string;
  beforeEach(() => {
    dir = fixture();
  });

  it('removes what a deleted source left in dist/ — a plain build keeps it, and a tarball would carry it', () => {
    expect(build(dir)).toBe(0);
    writeFileSync(join(dir, 'src/gone.ts'), 'export const gone = 1;\n');
    expect(build(dir)).toBe(0);
    rmSync(join(dir, 'src/gone.ts'));

    expect(build(dir)).toBe(0);
    expect(existsSync(join(dir, 'dist/gone.js'))).toBe(true); // tsc -b never deletes

    expect(build(dir, { clean: true })).toBe(0);
    expect(existsSync(join(dir, 'dist/gone.js'))).toBe(false);
    expect(existsSync(join(dir, 'dist/gone.d.ts'))).toBe(false);
    expect(existsSync(join(dir, 'dist/kept.js'))).toBe(true);
  });

  it('removes the build info too — otherwise tsc -b thinks the emptied dist/ is up to date and writes nothing', () => {
    expect(build(dir)).toBe(0);
    expect(existsSync(join(dir, 'tsconfig.tsbuildinfo'))).toBe(true);
    writeFileSync(join(dir, 'dist/orphan.js'), '');

    expect(build(dir, { clean: true })).toBe(0);
    expect(existsSync(join(dir, 'dist/orphan.js'))).toBe(false);
    expect(existsSync(join(dir, 'dist/kept.js'))).toBe(true);
  });

  it('marks an island controller in the compiled JavaScript — one without a constructor or injections too', () => {
    writeFileSync(join(dir, 'src/panel.ts'), 'export class PanelController {\n  island(view: unknown, props: object) {\n    return [view, props];\n  }\n  handle() {\n    return this.island(null, {});\n  }\n}\n');
    expect(build(dir)).toBe(0);
    const compiled = readFileSync(join(dir, 'dist/panel.js'), 'utf8');
    expect(compiled).toContain('static [Symbol.for("marmeon.island-controller")] = true;');
    expect(compiled).not.toContain('static inject');
    expect(readFileSync(join(dir, 'dist/kept.js'), 'utf8')).not.toContain('marmeon.island-controller');
  });

  it('fails for a directory without a tsconfig.json — before building any, never "Built 0 package(s)"', () => {
    const empty = realpathSync(tempDir('marmeon-package-build-empty-'));
    try {
      const errors: string[] = [];
      const output = { ...silent, error: (text: string) => void errors.push(text) };
      const code = new PackageBuildCommand().handle({ args: [dir, empty], options: {}, output: output as never, root: dir, spawn: async () => 0, prompt: noPrompt });
      expect([code, errors]).toEqual([1, [`${relative(dir, empty)} has no tsconfig.json — nothing to build there. Name the directories of your packages.`]]);
      expect(existsSync(join(dir, 'dist/kept.js')), 'a package was built before the error').toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses an outDir that is not inside the package', () => {
    const outside = fixture('.');
    try {
      expect(() => build(outside, { clean: true })).toThrow(/refusing to clean outDir "\." — it is not inside the package/);
      expect(existsSync(join(outside, 'src/kept.ts'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
