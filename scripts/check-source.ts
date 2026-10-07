/**
 * `pnpm check:source` — rules over the repository's own files, a part of `pnpm run ci` (W10 step 1). Exit 1 names every hit.
 *
 *   1. **The old name is gone** (E195, E196): no file of the repository — tracked, or new and not ignored — and no path says the
 *      framework's name from before 0.1.0, in any case. Allowed: the company name (`LICENSE` holder, E153 — every copy, the policies
 *      that name it, `check-changesets`' licence rule) and the one rename hint ("Marmeon was called … up to 0.1.0") in `README.md`
 *      and `UPGRADING.md`. A half-renamed repository does not always show: the temp hygiene, for one, finds leftovers by their
 *      prefix only — a helper with the old prefix and a hygiene with the new one would agree on nothing and stay green.
 *
 *   2. **No app installs a validation engine** (E197, W10 step 4): apps, the starter's template, the `make:auth` stubs and what a
 *      script or a generator writes into an app validate with `rules` of @marmeon/validation — no file outside `packages/<name>/src/`
 *      imports Valibot (in code or in the code a generator writes: `make:*`'s templates count), and no `package.json` of an app or of
 *      the template lists it. Inside a package's `src/` Valibot stays an internal engine (its env schemas, its tests).
 *
 *   3. **`NODE_ENV` is checked positively** (E201, W10 step 6): no `!== 'production'` (any quotes, also `!=`) and no
 *      `NODE_ENV === 'production'` in a package's code (`packages/<name>/src/` and the `make:auth` stubs, tests and fixtures aside).
 *      Either sends `staging`, a typo or a missing `NODE_ENV` down the development branch — long messages, warnings, devtools hooks
 *      and error details in server rendering, which reads `NODE_ENV` at run time. Development branches ask
 *      `process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` (inline: a client build folds it away), server
 *      code `environment.isDevelopment()` / `environment.isProtected()` of @marmeon/core.
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

/** The engine under `rules` (E197), spelled in parts like the old name: this file holds no import of it either. */
export const ENGINE = ['vali', 'bot'].join('');
const IMPORT = new RegExp(
  [
    `\\bfrom\\s+['"\`]${ENGINE}(?:/[^'"\`]*)?['"\`]`, // import … from (also export … from)
    `\\bimport\\s*\\(\\s*['"\`]${ENGINE}(?:/[^'"\`]*)?['"\`]`, // a dynamic import
    `\\brequire\\s*\\(\\s*['"\`]${ENGINE}['"\`]`,
    `^\\s*import\\s+['"\`]${ENGINE}['"\`]`, // a bare import
  ].join('|'),
  'm',
);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
/** Generators whose source is app code: the templates of `make:*` write into an app. */
export const GENERATORS: readonly string[] = ['packages/cli/src/commands/make.ts'];
/** The manifests of apps and of the starter's template — never a validation engine of their own. */
const APP_MANIFEST = /^(?:apps\/[^/]+\/package\.json|packages\/create-marmeon\/template\/.*_?package\.json)$/;

/** Rule 2: every import of the engine outside a package's `src/` (or in a generator) and every app manifest that lists it. */
export function engineHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (APP_MANIFEST.test(path)) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // not JSON: the template's own checks catch it
      }
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (Object.hasOwn((manifest[field] ?? {}) as object, ENGINE)) hits.push(`${path}: ${field} lists ${ENGINE} — an app validates with @marmeon/validation`);
      }
      continue;
    }
    if (!CODE.test(path) || (/^packages\/[^/]+\/src\//.test(path) && !GENERATORS.includes(path)) || !IMPORT.test(text)) continue;
    text.split('\n').forEach((line, index) => {
      if (IMPORT.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return hits;
}

/** `!== 'production'` / `!= "production"` (either side), and `NODE_ENV === 'production'` — what rule 3 refuses. */
const NEGATIVE_ENV = new RegExp(
  [
    `!==?\\s*(['"\`])production\\1`, // x !== 'production'
    `(['"\`])production\\2\\s*!==?`, // 'production' !== x
    `NODE_ENV\\s*===?\\s*(['"\`])production\\3`, // NODE_ENV === 'production' (staging falls into the else)
    `(['"\`])production\\4\\s*===?\\s*(?:process\\.env\\.|env\\.)?NODE_ENV`,
  ].join('|'),
);
/** A package's own code — sources and the stubs it writes into apps — not its tests and fixtures. */
const PACKAGE_CODE = /^packages\/[^/]+\/(?:src|stubs)\/(?!.*(?:\.test\.|\.type-test\.|__fixtures__\/))/;

/** Rule 3: every negative or `=== 'production'` check of the environment in a package's code. */
export function negativeEnvHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!CODE.test(path) || !PACKAGE_CODE.test(path) || !NEGATIVE_ENV.test(text)) continue;
    text.split('\n').forEach((line, index) => {
      if (NEGATIVE_ENV.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
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
  const files = repositoryFiles(repository);
  return [
    ...oldNameHits(files).map((hit) => `the old name (E196): ${hit}`),
    ...engineHits(files).map((hit) => `no ${ENGINE} in apps, stubs and templates (E197): ${hit}`),
    ...negativeEnvHits(files).map(
      (hit) => `NODE_ENV checked positively (E201 — staging is not development): use === 'development' || === 'test', or environment.isDevelopment()/isProtected(): ${hit}`,
    ),
  ];
}

if (import.meta.main) {
  const problems = checkSource();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\ncheck:source: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    console.log(`check:source: no file or path says the old name (allowed: the company name and the one rename hint); no app, stub, template or generator imports or installs ${ENGINE}; no package checks NODE_ENV against 'production'.`);
  }
}
