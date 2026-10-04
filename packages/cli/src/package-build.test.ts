import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackageBuildCommand } from './commands/package-build.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const silent = { line: () => {}, success: () => {}, error: () => {}, info: () => {}, warn: () => {}, table: () => {} };

/** A package outside the repository: one source, TypeScript linked in, and the leftovers of an earlier build. */
function fixture(outDir = 'dist'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-package-build-')));
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
  return new PackageBuildCommand().handle({ args: [dir], options, output: silent as never, root: dir, spawn: async () => 0 });
}

describe('bespoke package:build --clean (E156)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fixture();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
