import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { browserSources, embedPackageInjections } from '@marmeon/core';
import type { CommandInput } from '../command.ts';

/**
 * Builds packages with `tsc -b`, then embeds the injection lists into dist/ — so a
 * published package carries them and consumers need nothing (roadmap E1). Browser-only
 * sources (`"marmeon": { "browser": [...] }` in package.json) get none (E76).
 *
 * `--clean` empties every given package's output directory and removes its `*.tsbuildinfo` first: `tsc -b` never
 * deletes what a renamed or removed source left behind, and a tarball would carry it (E156). `pnpm pack:check`
 * always builds that way.
 */
export class PackageBuildCommand {
  static command = 'package:build';
  static description = 'Build packages and embed their injection lists';
  static usage = '[package directories…] [--clean]';
  static options = { clean: { type: 'boolean' } } as const;
  static boots = false;

  handle({ args, options, output, root }: CommandInput): number {
    const directories = (args.length ? args : ['.']).map((dir) => resolve(root, dir));
    // A directory without a tsconfig.json is no package to build — said before any build, never "Built 0 package(s)".
    const missing = directories.find((dir) => !existsSync(join(dir, 'tsconfig.json')));
    if (missing) {
      output.error(`${relative(root, missing) || '.'} has no tsconfig.json — nothing to build there. Name the directories of your packages.`);
      return 1;
    }

    // All of them before any build: `tsc -b` builds a package's references too, which must not be cleaned afterwards.
    if (options.clean === true) for (const dir of directories) clean(dir);

    for (const dir of directories) {
      const tsc = findTsc(dir);
      if (!tsc) {
        output.error(`${relative(root, dir) || '.'}: TypeScript is not installed.`);
        return 1;
      }
      const result = spawnSync(process.execPath, [tsc, '-b', dir], { stdio: 'inherit' });
      if (result.status !== 0) return result.status ?? 1;

      const { rootDir = 'src', outDir = 'dist' } = readCompilerOptions(join(dir, 'tsconfig.json'));
      const changed = embedPackageInjections({ srcDir: join(dir, rootDir), outDir: join(dir, outDir), browser: browserSources(dir) });
      for (const file of changed) output.line(`  embedded → ${relative(root, file)}`);
    }
    output.success(`Built ${directories.length} package(s)`);
    return 0;
  }
}

/** Removes the package's output directory and its build info — what `tsc -b` would otherwise only add to. */
function clean(dir: string): void {
  const { outDir = 'dist', tsBuildInfoFile } = readCompilerOptions(join(dir, 'tsconfig.json'));
  const out = resolve(dir, outDir);
  // Only a directory inside the package — never the package itself or anything above it.
  if (relative(dir, out).startsWith('..') || out === dir) throw new Error(`${dir}: refusing to clean outDir "${outDir}" — it is not inside the package.`);
  rmSync(out, { recursive: true, force: true });
  if (tsBuildInfoFile) rmSync(resolve(dir, tsBuildInfoFile), { force: true });
  for (const entry of readdirSync(dir)) if (entry.endsWith('.tsbuildinfo')) rmSync(join(dir, entry), { force: true });
}

function findTsc(dir: string): string | undefined {
  try {
    const manifest = createRequire(join(dir, 'package.json')).resolve('typescript/package.json');
    return join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
  } catch {
    return undefined;
  }
}

function readCompilerOptions(tsconfig: string): { rootDir?: string; outDir?: string; tsBuildInfoFile?: string } {
  try {
    return JSON.parse(readFileSync(tsconfig, 'utf8')).compilerOptions ?? {};
  } catch {
    return {};
  }
}
