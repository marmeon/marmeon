/**
 * `pnpm check:source` — rules over the repository's own files, a part of `pnpm run ci` (W10 step 1). Exit 1 names every hit.
 *
 *   1. **The old name is gone** (E195, E196): no file of the repository — tracked, or new and not ignored — and no path says the
 *      framework's name from before 0.1.0, in any case. Allowed: the company name (`LICENSE` holder, E153 — every copy, the policies
 *      that name it, `check-changesets`' licence rule) and the one rename hint ("Marmeon was called … up to 0.1.0") in `README.md`
 *      and `UPGRADING.md`. A half-renamed repository does not always show: the temp hygiene, for one, finds leftovers by their
 *      prefix only — a helper with the old prefix and a hygiene with the new one would agree on nothing and stay green.
 *
 * Later rules join this script (one script, several rules, each with its test and Gegenprobe).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The old name, spelled in parts — this file (and its test) must pass its own rule. */
export const OLD_NAME = ['Bes', 'poke'].join('');
const OLD = new RegExp(OLD_NAME, 'i');

interface Allowance {
  readonly pattern: RegExp;
  /** Only in these files (relative, forward slashes); everywhere when missing. */
  readonly files?: readonly string[];
}

/** What may still say the old name — each a whole phrase, never the word alone. */
export const ALLOWED: readonly Allowance[] = [
  // The company (E153): the LICENSE holder and every place that names it.
  { pattern: new RegExp(`\\b${OLD_NAME}Code\\b`, 'g') },
  // The one rename hint (E196): no entry per name, only this sentence.
  { pattern: new RegExp(`Marmeon was called ${OLD_NAME}Core up to 0\\.1\\.0`, 'g'), files: ['README.md', 'UPGRADING.md'] },
];

export interface SourceFile {
  /** Relative to the repository, forward slashes. */
  readonly path: string;
  readonly text: string;
}

/** Rule 1: every path and line that says the old name outside the allowances — `path:line: text`. */
export function oldNameHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (OLD.test(path)) hits.push(`${path}: the path says the old name — rename it (git mv)`);
    if (!OLD.test(text)) continue;
    const allowed = ALLOWED.filter((allowance) => !allowance.files || allowance.files.includes(path));
    text.split('\n').forEach((line, index) => {
      if (!OLD.test(line)) return;
      const rest = allowed.reduce((remaining, allowance) => remaining.replace(allowance.pattern, ''), line);
      if (OLD.test(rest)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return hits;
}

/** The repository's files as git sees them: tracked, and new ones that are not ignored — text only, as they are on disk. */
export function repositoryFiles(repository: string = root): SourceFile[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${repository}: ${listed.stderr}`);
  const files: SourceFile[] = [];
  for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
    const file = join(repository, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue; // deleted in the working tree, or a submodule
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) {
      files.push({ path, text: '' }); // binary: its path still counts
      continue;
    }
    files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
}

/** Every rule over `repository`; [] when all hold. */
export function checkSource(repository: string = root): string[] {
  return oldNameHits(repositoryFiles(repository)).map((hit) => `the old name (E196): ${hit}`);
}

if (import.meta.main) {
  const problems = checkSource();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\ncheck:source: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    console.log(`check:source: no file or path says the old name (allowed: the company name and the one rename hint).`);
  }
}
