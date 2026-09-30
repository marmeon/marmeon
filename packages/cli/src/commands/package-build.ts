import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { embedPackageInjections } from '@bespokecore/core';
import type { CommandInput } from '../command.ts';

/**
 * Builds packages with `tsc -b`, then embeds the injection lists into dist/ — so a
 * published package carries them and consumers need nothing (roadmap E1).
 */
export class PackageBuildCommand {
  static command = 'package:build';
  static description = 'Build packages and embed their injection lists';
  static usage = '[package directories…]';
  static boots = false;

  handle({ args, output, root }: CommandInput): number {
    const directories = (args.length ? args : ['.']).map((dir) => resolve(root, dir)).filter((dir) => existsSync(join(dir, 'tsconfig.json')));

    for (const dir of directories) {
      const tsc = findTsc(dir);
      if (!tsc) {
        output.error(`${relative(root, dir) || '.'}: TypeScript is not installed.`);
        return 1;
      }
      const result = spawnSync(process.execPath, [tsc, '-b', dir], { stdio: 'inherit' });
      if (result.status !== 0) return result.status ?? 1;

      const { rootDir = 'src', outDir = 'dist' } = readCompilerOptions(join(dir, 'tsconfig.json'));
      const changed = embedPackageInjections({ srcDir: join(dir, rootDir), outDir: join(dir, outDir) });
      for (const file of changed) output.line(`  embedded → ${relative(root, file)}`);
    }
    output.success(`Built ${directories.length} package(s)`);
    return 0;
  }
}

function findTsc(dir: string): string | undefined {
  try {
    const manifest = createRequire(join(dir, 'package.json')).resolve('typescript/package.json');
    return join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
  } catch {
    return undefined;
  }
}

function readCompilerOptions(tsconfig: string): { rootDir?: string; outDir?: string } {
  try {
    return JSON.parse(readFileSync(tsconfig, 'utf8')).compilerOptions ?? {};
  } catch {
    return {};
  }
}
