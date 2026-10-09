/**
 * `pnpm check:source` — rules over the repository's own files, a part of `pnpm run ci` (W10 step 1). Exit 1 names every hit.
 *
 *   1. **The old name is gone** (E195, E196): no file of the repository — tracked, or new and not ignored — and no path says the
 *      framework's name from before 0.1.0, in any case. Allowed: the company name (`LICENSE` holder, E153 — every copy, the policies
 *      that name it, `check-changesets`' licence rule) — no rename hint: nothing was released under the old name (E216). A
 *      half-renamed repository does not always show: the temp hygiene, for one, finds leftovers by their prefix only — a helper
 *      with the old prefix and a hygiene with the new one would agree on nothing and stay green.
 *
 *   2. **No app installs a validation engine** (E197, W10 step 4): apps, the starter's template, the `make:auth` stubs and what a
 *      script or a generator writes into an app validate with `rules` of @marmeon/validation — no file outside `packages/<name>/src/`
 *      imports Valibot (in code or in the code a generator writes: `make:*`'s templates count), and no `package.json` of an app or of
 *      the template lists it. Inside a package's `src/` Valibot stays an internal engine (its env schemas, its tests).
 *
 *   3. **`NODE_ENV` is checked positively** (E201, W10 step 6): no `!== 'production'` (any quotes, also `!=`), no
 *      `NODE_ENV === 'production'` and no `import.meta.env.DEV` / `!import.meta.env.PROD` (Vite sets them from `NODE_ENV ===
 *      'production'`: a staging build is `DEV`) in a package's code (`packages/<name>/src/`, the `make:auth` stubs), the starter's
 *      template (`packages/create-marmeon/template/`) and the apps (`apps/<name>/`) — what people copy — tests and fixtures aside.
 *      Either sends `staging`, a typo or a missing `NODE_ENV` down the development branch — long messages, warnings, devtools hooks
 *      and error details in server rendering, which reads `NODE_ENV` at run time. Development branches ask
 *      `process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` (inline: a client build folds it away), server
 *      code `environment.isDevelopment()` / `environment.isProtected()` of @marmeon/core.
 *
 *   4. **The old default prefix of API tokens is gone** (E207, W10 step 9b): `AUTH_TOKEN_PREFIX` defaults to `marmeon_`; no file says
 *      the two-letter prefix of before (before a digit, `|`, a quote, whitespace or the line's end), not even as a way back in
 *      `UPGRADING.md`: no release handed out a token with it (E216). A forgotten copy in a test or a README would teach the old default.
 *
 *   5. **The docs speak to their readers** (W11 step 10, E214, E215): the pages under `docs/`, the packages' READMEs (their npm
 *      cards), the root `README.md` and the policies the docs show (`UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`) carry no
 *      decision number (`E` and two or three digits — a hex value, an exponent, `E2E` or `E.164` is none) and no comparison with
 *      another framework; the pages, the cards and the upgrade guide no wave reference (`W9`, `W10.4`, `Wave 9`) —
 *      `CONTRIBUTING.md` names the Gegenproben's paths (`scripts/gegen/w10/…`) and steps (`'W9.4'`); and no page under `docs/` the
 *      pending marker as a line of its own — every page is written (`CONTRIBUTING.md` names the marker inline). What every new app
 *      copies — the starter's template and the packages' stubs — carries no decision number, no wave reference, no personal date
 *      ("Max 07.10.") and no comparison with another framework. Each part is an entry of {@link DOC_TEXT_RULES}: its pattern and
 *      the files it reads.
 *
 *   6. **The framework's messages speak to app developers** (W11 step 10, E214): the strings of a package's code
 *      (`packages/<name>/src/`, tests, type tests and fixtures aside, and the launchers `packages/<name>/bin/*.js`) — errors,
 *      warnings, solutions, command descriptions and
 *      output, the files `make:*` writes, the devtools' pages — carry no decision number, no wave reference and no other framework,
 *      as rule 5's patterns find them. Only strings count (read with oxc-parser): comments, names and regular expressions are the
 *      maintainers' and keep their decision numbers.
 *
 * Later rules join this script (one script, several rules, each with its test and Gegenprobe).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** What may still say the old name — a whole phrase, never the word alone. No rename hint: nothing was released under the old name (E216). */
export const ALLOWED: readonly Allowance[] = [
  // The company (E153): the LICENSE holder and every place that names it.
  { pattern: new RegExp(`\\b${OLD_NAME}Code\\b`, 'g') },
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

/** The old default prefix of API tokens (E207), spelled in parts: this file passes its own rule. */
export const OLD_TOKEN_PREFIX = `${['b', 'c'].join('')}_`;
const OLD_PREFIX = new RegExp(`(?<![\\w-])${OLD_TOKEN_PREFIX}(?=[\\d|'"\`\\s]|$)`, 'm');
/** Where the old prefix may stand: nowhere — no release handed out a token with it, so there is no way back to give (E216). */
const OLD_PREFIX_ALLOWED: readonly Allowance[] = [];

/** Rule 4: every line that says the old token prefix outside its allowance — `path:line: text`. */
export function oldTokenPrefixHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!OLD_PREFIX.test(text)) continue;
    const allowed = OLD_PREFIX_ALLOWED.filter((allowance) => !allowance.files || allowance.files.includes(path));
    text.split('\n').forEach((line, index) => {
      const rest = allowed.reduce((remaining, allowance) => remaining.replace(allowance.pattern, ''), line);
      if (OLD_PREFIX.test(rest)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
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
    `\\bimport\\.meta\\.env\\.DEV\\b`, // Vite's DEV: true for any NODE_ENV but production (a staging build)
    `!\\s*import\\.meta\\.env\\.PROD\\b`,
  ].join('|'),
);
/**
 * Code people run or copy — a package's sources and the stubs it writes into apps, the starter's template, the apps — not tests
 * and fixtures.
 */
const PACKAGE_CODE = /^(?:packages\/[^/]+\/(?:src|stubs)\/|packages\/create-marmeon\/template\/|apps\/[^/]+\/)(?!.*(?:\.test\.|\.type-test\.|__fixtures__\/))/;

/** Rule 3: every negative or `=== 'production'` check of the environment in code people run or copy (packages, template, apps). */
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

/** One part of rule 5: a pattern no line of the files it reads may match. */
export interface TextRule {
  /** What the pattern finds, for the problem's message: `a decision number`. */
  readonly what: string;
  readonly pattern: RegExp;
  /** The files it reads (relative paths, forward slashes): any of them. */
  readonly files: readonly RegExp[];
  /** Why, and what to write instead. */
  readonly why: string;
}

/** The pages of the docs. */
const DOCS_PAGES = /^docs\/[^/]+\.md$/;
/** The packages' READMEs — what npm shows. */
const PACKAGE_CARDS = /^packages\/[^/]+\/README\.md$/;
/** The root README and the policies the docs show as pages (Upgrade Guide, Contributing, Security Policy). */
const ROOT_TEXTS = /^(?:README|CONTRIBUTING|SECURITY|UPGRADING)\.md$/;
/** The upgrade guide: it says what changed by version, not by wave. */
const UPGRADE_GUIDE = /^UPGRADING\.md$/;
/**
 * What every new app copies and keeps: the starter's template (`create-marmeon`) and the packages' stubs (`make:auth`'s module,
 * the migrations of `make:queue-table`, `make:session-table`, …) — every comment of them lands in an app, so it speaks to that
 * app's developers. The code that copies them (`packages/<name>/src/`) is the maintainers' and keeps its decision numbers.
 */
const APP_COPIES = /^packages\/(?:create-marmeon\/template|[^/]+\/stubs)\//;

/** Rule 5: the docs speak to their readers — no decision numbers, no wave references, no page still to be written. */
export const DOC_TEXT_RULES: readonly TextRule[] = [
  {
    what: 'a decision number',
    // A word of its own: `0xE12`, `#E1234`, `1E10`, `E2E` and `E.164` are none.
    pattern: /\bE\d{2,3}\b/,
    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES],
    why: 'say what was decided, not its number — the decisions are the maintainers\' record',
  },
  {
    what: 'a wave reference',
    pattern: /\b(?:W\d+(?:\.\d+)?|[Ww]ave \d+)\b/,
    // Not CONTRIBUTING.md: it names the Gegenproben's paths (`scripts/gegen/w10/…`) and steps (`step: 'W9.4'`).
    files: [DOCS_PAGES, PACKAGE_CARDS, UPGRADE_GUIDE, APP_COPIES],
    why: 'the docs describe the framework as it is, not when it changed — UPGRADING.md says that, by version',
  },
  {
    what: 'the pending marker',
    pattern: /^\s*<!-- docs:pending -->\s*$/,
    files: [DOCS_PAGES],
    why: 'every page is written — write it, or take it out of apps/docs/docs.config.ts and docs/',
  },
  {
    what: 'a personal date',
    // Who decided and when ("Max 07.10."): a name of its own (not `Max-Age`) or a day and a month with their dots.
    pattern: /\bMax\b(?![-\w])|(?<![\d.])\d{2}\.\d{2}\.(?!\d)/,
    files: [APP_COPIES],
    why: 'a new app keeps the reason, not who decided it when — the maintainers\' record has that',
  },
  {
    what: 'a comparison with another framework',
    pattern: /\b(?:Laravel|Breeze|Inertia|Rails|Django|Symfony|AdonisJS|NestJS|Next\.js|Nuxt)\b/,
    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES],
    why: 'describe Marmeon as it is — a reader may know no other framework',
  },
];

/** Where a hit of rule 5 stands, for its message: the docs, or what every new app copies. */
export function textRuleWhere(path: string): string {
  return APP_COPIES.test(path) ? 'in what every new app copies' : 'in the docs';
}

/** Rule 5, one part: every line of the files `rule` reads that matches its pattern — `path:line: text`. */
export function textRuleHits(files: Iterable<SourceFile>, rule: TextRule): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!rule.files.some((pattern) => pattern.test(path)) || !text.split('\n').some((line) => rule.pattern.test(line))) continue;
    text.split('\n').forEach((line, index) => {
      if (rule.pattern.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return hits;
}

/** A package's code, as it runs in an app: `packages/<name>/src/` (its tests, type tests and fixtures aside) and its launchers (`bin/*.js`). */
const RUNTIME_CODE = /^packages\/[^/]+\/(?:src\/(?!.*__fixtures__\/).+(?<!\.test|\.type-test)\.tsx?|bin\/[^/]+\.js)$/;
/** What rule 6 looks for in the strings of that code: rule 5's parts that hold for every text an app developer reads. */
const RUNTIME_TEXT_RULES = DOC_TEXT_RULES.filter((rule) => ['a decision number', 'a wave reference', 'a comparison with another framework'].includes(rule.what));

/** What rule 6 uses of oxc-parser: an ESTree program, and the errors of a file it cannot read. */
interface OxcParser {
  parseSync(filename: string, text: string): { program: unknown; errors: readonly { message: string }[] };
}
/** oxc-parser — the parser of `@marmeon/core` (this script runs from the repository's root, which does not depend on it). */
const oxc = (): OxcParser => createRequire(join(root, 'packages/core/package.json'))('oxc-parser') as OxcParser;

/**
 * Rule 6: the strings of a package's code — messages, warnings, solutions, command descriptions and output, what `make:*`
 * writes, the devtools' pages — carry no decision number, no wave reference and no other framework: every app shows them. A
 * string literal, a template's text and JSX text count; comments, names and regular expressions are the maintainers' and do not.
 * `path:line: what: text`.
 */
export function runtimeStringHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!RUNTIME_CODE.test(path) || !RUNTIME_TEXT_RULES.some((rule) => rule.pattern.test(text))) continue;
    const { program, errors } = oxc().parseSync(path, text);
    if (errors.length > 0) throw new Error(`${path}: oxc-parser cannot read it: ${errors[0]!.message}`);
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)];
    const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node === null || typeof node !== 'object') return;
      const { type, start, end, value } = node as { type?: string; start?: number; end?: number; value?: unknown };
      const isText = (type === 'Literal' && typeof value === 'string') || type === 'TemplateElement' || type === 'JSXText';
      if (isText && start !== undefined && end !== undefined) {
        text.slice(start, end).split('\n').forEach((line, index) => {
          for (const rule of RUNTIME_TEXT_RULES) {
            if (rule.pattern.test(line)) hits.push(`${path}:${lineOf(start) + index}: ${rule.what}: ${line.trim().slice(0, 160)}`);
          }
        });
        return;
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'parent') visit(child);
    };
    visit(program);
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
    ...oldTokenPrefixHits(files).map((hit) => `the old token prefix (E207 — API tokens start with marmeon_): ${hit}`),
    ...DOC_TEXT_RULES.flatMap((rule) => textRuleHits(files, rule).map((hit) => `${rule.what} ${textRuleWhere(hit)} (${rule.why}): ${hit}`)),
    ...runtimeStringHits(files).map((hit) => `the framework's messages speak to app developers (say what holds, not its decision or wave): ${hit}`),
  ];
}

if (import.meta.main) {
  const problems = checkSource();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\ncheck:source: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    console.log(`check:source: no file or path says the old name (allowed: the company name); no app, stub, template or generator imports or installs ${ENGINE}; no package, template or app checks NODE_ENV against 'production' (or asks import.meta.env.DEV); no file says the old token prefix; the docs, the package cards and the policies (the upgrade guide among them) name no decision number and compare Marmeon with no other framework; the docs, the cards and the upgrade guide name no wave, no page is pending; the starter's template and the packages' stubs name no decision number, wave, personal date or other framework; no string of a package's code or launchers names a decision, a wave or another framework.`);
  }
}
