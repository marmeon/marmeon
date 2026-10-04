/**
 * `pnpm license:sync` — copies the repository's `LICENSE` into every framework package (E157): a tarball carries its own
 * licence text (MIT asks for it in every copy), and only pnpm would fall back to the root file.
 *
 *   pnpm license:sync            # write the copies
 *   node scripts/sync-license.ts --check   # exit 1 and name every package whose copy is missing or differs (pack:check runs this)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkPackages } from './packages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The packages whose `LICENSE` is not the root's, as paths relative to the repository. */
export function licenseDrift(repository: string = root): string[] {
  const license = readFileSync(join(repository, 'LICENSE'), 'utf8');
  return frameworkPackages(repository)
    .map((pkg) => join(pkg.dir, 'LICENSE'))
    .filter((file) => !existsSync(file) || readFileSync(file, 'utf8') !== license)
    .map((file) => relative(repository, file));
}

if (import.meta.main) {
  const drift = licenseDrift();
  if (process.argv.includes('--check')) {
    if (drift.length > 0) {
      console.error(`license: ${drift.join(', ')} ${drift.length === 1 ? 'is' : 'are'} missing or not the root LICENSE — run pnpm license:sync.`);
      process.exitCode = 1;
    } else console.log('license: every package carries the root LICENSE.');
  } else {
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    for (const file of drift) writeFileSync(join(root, file), license);
    console.log(drift.length > 0 ? `license: wrote ${drift.join(', ')}` : 'license: every package carries the root LICENSE.');
  }
}
