/**
 * The tarballs of a release, as the staging job will stage them: `pnpm pack` of every published package into one directory, and a
 * `SHA512SUMS` file (`sha512sum`'s format) naming each. The hash of `SHA512SUMS` itself is the job's output `sums` — the staging job
 * checks the downloaded files against it before it stages anything, so it stages exactly what this job packed and hashed.
 *
 * Imports nothing but `node:*` and `./packages.ts`. The hash proves that the files did not change on their way to the staging job,
 * not that this job packed honest ones: a maintainer rebuilds the release commit and compares the hashes before approving on npm
 * (CONTRIBUTING.md, "Releasing").
 *
 *   node scripts/release-pack.ts <directory>   # a new or empty directory; GITHUB_OUTPUT (if set) receives `sums=<sha512>`
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkPackages, packAll, type PackedPackage } from './packages.ts';

/** The file that names every tarball with its SHA-512. */
export const SUMS_FILE = 'SHA512SUMS';

const sha512 = (data: Uint8Array | string) => createHash('sha512').update(data).digest('hex');

export interface ReleasePack {
  /** The tarball file names, sorted. */
  readonly tarballs: readonly string[];
  /** The hash of the `SHA512SUMS` file. */
  readonly sums: string;
}

/**
 * Packs every published package into `directory` and writes `SHA512SUMS` there. Throws when the directory is not empty (an old
 * tarball would be hashed and staged with the new ones) or when a package made no tarball.
 */
export function releasePack(
  root: string,
  directory: string,
  pack: (root: string, destination: string) => readonly Pick<PackedPackage, 'name' | 'tarball'>[] = packAll,
): ReleasePack {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length > 0) throw new Error(`${directory} is not empty — the tarballs of a release go into a fresh directory`);
  const packed = new Map(pack(root, directory).map((entry) => [entry.name, basename(entry.tarball)]));
  const tarballs: string[] = [];
  for (const pkg of frameworkPackages(root)) {
    const file = packed.get(pkg.name);
    if (file === undefined) throw new Error(`pnpm pack made no tarball for ${pkg.name}`);
    tarballs.push(file);
  }
  tarballs.sort();
  const sums = tarballs.map((file) => `${sha512(readFileSync(join(directory, file)))}  ${file}\n`).join('');
  writeFileSync(join(directory, SUMS_FILE), sums);
  return { tarballs, sums: sha512(sums) };
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) {
    console.error('usage: node scripts/release-pack.ts <directory>');
    process.exit(1);
  }
  try {
    const result = releasePack(fileURLToPath(new URL('..', import.meta.url)), directory);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sums=${result.sums}\n`);
    console.log(readFileSync(join(directory, SUMS_FILE), 'utf8').trimEnd());
    console.log(`release-pack: ${result.tarballs.length} tarballs, ${SUMS_FILE} hash ${result.sums}`);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  }
}
