/**
 * Stand-in for `bespoke package:build` until the CLI exists (Wave 1, step 9):
 * after `tsc -b`, embed the generated injection lists into every package's dist/.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { embedPackageInjections } from '@bespokecore/core';

const root = join(import.meta.dirname, '..', 'packages');
let total = 0;
for (const name of readdirSync(root)) {
  if (!existsSync(join(root, name, 'src'))) continue; // skip .DS_Store and friends
  const changed = embedPackageInjections({ srcDir: join(root, name, 'src'), outDir: join(root, name, 'dist') });
  for (const file of changed) console.log(`  embedded → ${file.slice(root.length + 1)}`);
  total += changed.length;
}
console.log(`package:build — ${total} file(s) with injection lists or unresolvable reasons`);
