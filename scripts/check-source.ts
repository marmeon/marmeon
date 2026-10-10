/**
 * `pnpm check:source` — rules over the repository's own files, a part of `pnpm run ci`. Exit 1 names every hit.
 *
 *   1. **The old name is gone:** no file — tracked, or new and not ignored — and no path says the framework's name from before
 *      0.1.0, in any case. Only the company name may contain it.
 *   2. **No app installs a validation engine:** apps, the starter's template, the stubs and what a generator writes validate with
 *      `rules` of @marmeon/validation — no file outside `packages/<name>/src/` imports Valibot, no app manifest lists it.
 *   3. **`NODE_ENV` is checked positively** in code people run or copy: no `!== 'production'`, no `NODE_ENV === 'production'`, no
 *      `import.meta.env.DEV` / `!import.meta.env.PROD` — each sends a missing `NODE_ENV` (production) down the development branch.
 *   4. **The old default prefix of API tokens is gone**, everywhere.
 *   5. **The docs speak to their readers:** no page under `docs/` is pending, and the docs, the package cards, the root texts,
 *      what every new app copies and the apps' READMEs and `.env` files compare Marmeon with no other framework.
 *   6. **The framework's messages speak to app developers:** no string of a package's code or launchers names a decision, a wave
 *      or another framework (read with oxc-parser — comments, names and regular expressions are rule 7's).
 *   7. **No references to the private record:** no tracked file names a decision number, a wave or a step, a personal date or a
 *      path into the maintainers' notes. {@link PENDING_AREAS} lists the areas it does not read yet.
 *
 * Each rule in full: CONTRIBUTING.md, "Rules over the source".
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

/** What may still say the old name — a whole phrase, never the word alone. No rename hint: nothing was released under the old name. */
export const ALLOWED: readonly Allowance[] = [
  // The company: the LICENSE holder and every place that names it.
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

/** The old default prefix of API tokens, spelled in parts: this file passes its own rule. */
export const OLD_TOKEN_PREFIX = `${['b', 'c'].join('')}_`;
const OLD_PREFIX = new RegExp(`(?<![\\w-])${OLD_TOKEN_PREFIX}(?=[\\d|'"\`\\s]|$)`, 'm');
/** Where the old prefix may stand: nowhere — no release handed out a token with it, so there is no way back to give. */
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

/** The engine under `rules`, spelled in parts like the old name: this file holds no import of it either. */
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
    `NODE_ENV\\s*===?\\s*(['"\`])production\\3`, // NODE_ENV === 'production' (a missing NODE_ENV falls into the else)
    `(['"\`])production\\4\\s*===?\\s*(?:process\\.env\\.|env\\.)?NODE_ENV`,
    `\\bimport\\.meta\\.env\\.DEV\\b`, // Vite's DEV: true for any NODE_ENV but production (a build without one)
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

/** One part of rule 5 or 7: a pattern no line of the files it reads may match. */
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
/** What every new app copies and keeps: the starter's template (`create-marmeon`) and the packages' stubs. */
const APP_COPIES = /^packages\/(?:create-marmeon\/template|[^/]+\/stubs)\//;
/** What a reader of one of the apps sees first and copies: its README and its `.env` files. */
const APP_TEXTS = /^apps\/[^/]+\/(?:README\.md|\.env\.[^/]+)$/;
/** Every file. */
const ALL_TRACKED = /^/;
/** Every file but the lockfile: its integrity hashes are base64, which holds a decision number or a wave by chance. */
const WRITTEN = /^(?!pnpm-lock\.yaml$)/;

/** Rule 5: the docs speak to their readers — no page still to be written, no other framework. */
export const DOC_TEXT_RULES: readonly TextRule[] = [
  {
    what: 'the pending marker',
    pattern: /^\s*<!-- docs:pending -->\s*$/,
    files: [DOCS_PAGES],
    why: 'every page is written — write it, or take it out of apps/docs/docs.config.ts and docs/',
  },
  {
    what: 'a comparison with another framework',
    pattern: /\b(?:Laravel|Breeze|Inertia|Rails|Django|Symfony|AdonisJS|NestJS|Next\.js|Nuxt)\b/,
    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES, APP_TEXTS],
    why: 'describe Marmeon as it is — a reader may know no other framework',
  },
];

/** Where a hit of rule 5 (`path:line: text`, or a path) stands, for its message: the docs, what every new app copies, or an app's texts. */
export function textRuleWhere(hit: string): string {
  const path = hit.replace(/:\d+: [\s\S]*$/, '');
  if (APP_COPIES.test(path)) return 'in what every new app copies';
  return APP_TEXTS.test(path) ? "in an app's README or .env files" : 'in the docs';
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

/** Rule 7: what points into the maintainers' private record — every tracked file outside {@link PENDING_AREAS}. */
export const PRIVATE_RECORD_RULES: readonly TextRule[] = [
  {
    what: 'a decision number',
    // A word of its own, one to three digits: `0xE12`, `#E1234`, `1E10`, `E2E`, `E.164`, the phone format `E164` and a
    // percent-encoded byte (`%E2%82%AC`) are none.
    pattern: /(?<!%)\bE(?!164\b)\d{1,3}\b/,
    files: [WRITTEN],
    why: 'say what holds, not which decision made it',
  },
  {
    what: 'a wave reference',
    // A wave or a step — a `W` or "wave" and its number, each with its letter, a point release and a step — a counter-probe's
    // id (a `G`, a number and a letter) or the words of the abolished method, in any case (spelled in parts: this file passes
    // its own rule); `W3C` is none.
    pattern: new RegExp(
      [
        String.raw`\b(?:W\d+[a-z]?(?:\.\d+[a-z]?)?(?:\s+step\s+\d+[a-z]?)?|[Ww]ave \d+[a-z]?(?:\s+step\s+\d+[a-z]?)?|G\d{1,2}[a-z])\b`,
        String.raw`\b(?i:${'counter'}-${'checks'}?|${'Gegen'}${'proben'}?)\b`,
      ].join('|'),
    ),
    files: [WRITTEN],
    why: 'describe the code as it is, not when it changed — UPGRADING.md says that, by version',
  },
  {
    what: 'a personal date',
    // Who decided and when: a name of its own (not `Max-Age`, not `Math.max`) or a day and a month with their dots (not `10.10.2026`).
    pattern: /\bMax\b(?![-\w])|(?<![\d.])\d{2}\.\d{2}\.(?!\d)/,
    files: [ALL_TRACKED],
    why: 'keep the reason, not who decided it when',
  },
  {
    what: 'a path into the private record',
    // Spelled in parts, like the old name: this file passes its own rule.
    pattern: new RegExp([`Naechste-${'Schritte'}`, `Obsi${'dian'}`, `\\bva${'ult'}\\b(?! fixture)`, `/private/${'tmp'}`, `scratch${'pad'}`].join('|'), 'i'),
    files: [ALL_TRACKED],
    why: 'point to a page under docs/ instead — the maintainers\' notes are not part of the repository',
  },
];

/**
 * The areas rule 7 does not read yet (path prefixes): their comments still name the private record. An area leaves the list
 * once its comments are clean. What readers see first in them — the package cards, the stubs, the starter's template and the
 * apps' READMEs and `.env` files — is read all the same.
 */
export const PENDING_AREAS: readonly string[] = [
  'packages/react/',
  'packages/router/',
  'packages/vite/',
  'packages/core/',
  'packages/server/',
  'packages/cli/',
  'packages/devtools/',
  'packages/create-marmeon/',
  'packages/encryption/',
  'packages/database/',
  'packages/table/',
  'packages/storage/',
  'packages/cache/',
  'packages/redis/',
  'packages/session/',
  'packages/queue/',
  'packages/scheduler/',
  'packages/notifications/',
  'packages/mail/',
  'packages/live/',
  'packages/auth/',
  'packages/validation/',
  'packages/i18n/',
  'packages/otel/',
  'packages/log/',
  'packages/testing/',
  'apps/web-app/',
  'apps/docs/',
  'apps/blank-app/',
];
/** Read even inside a pending area. */
const READER_TEXTS = [PACKAGE_CARDS, APP_COPIES, APP_TEXTS];

/** Rule 7: every line of the files outside `pending` that names the private record — `path:line: what: text`. */
export function privateRecordHits(files: Iterable<SourceFile>, pending: readonly string[] = PENDING_AREAS): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (pending.some((area) => path.startsWith(area)) && !READER_TEXTS.some((pattern) => pattern.test(path))) continue;
    if (!PRIVATE_RECORD_RULES.some((rule) => rule.pattern.test(text))) continue;
    text.split('\n').forEach((line, index) => {
      for (const rule of PRIVATE_RECORD_RULES) {
        if (rule.files.some((pattern) => pattern.test(path)) && rule.pattern.test(line)) hits.push(`${path}:${index + 1}: ${rule.what}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  return hits;
}

/** A package's code, as it runs in an app: `packages/<name>/src/` (its tests, type tests and fixtures aside) and its launchers (`bin/*.js`). */
const RUNTIME_CODE = /^packages\/[^/]+\/(?:src\/(?!.*__fixtures__\/).+(?<!\.test|\.type-test)\.tsx?|bin\/[^/]+\.js)$/;
/** What rule 6 looks for in the strings of that code. */
const RUNTIME_TEXT_RULES = [...PRIVATE_RECORD_RULES, ...DOC_TEXT_RULES].filter((rule) => ['a decision number', 'a wave reference', 'a comparison with another framework'].includes(rule.what));

/** What rule 6 uses of oxc-parser: an ESTree program, and the errors of a file it cannot read. */
interface OxcParser {
  parseSync(filename: string, text: string): { program: unknown; errors: readonly { message: string }[] };
}
/** oxc-parser — the parser of `@marmeon/core` (this script runs from the repository's root, which does not depend on it). */
const oxc = (): OxcParser => createRequire(join(root, 'packages/core/package.json'))('oxc-parser') as OxcParser;

/**
 * Rule 6: the strings of a package's code — messages, warnings, solutions, command descriptions and output, what `make:*`
 * writes, the devtools' pages — carry no decision number, no wave reference and no other framework: every app shows them. A
 * string literal, a template's text and JSX text count; comments, names and regular expressions are rule 7's.
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
    ...oldNameHits(files).map((hit) => `the old name: ${hit}`),
    ...engineHits(files).map((hit) => `no ${ENGINE} in apps, stubs and templates: ${hit}`),
    ...negativeEnvHits(files).map(
      (hit) => `NODE_ENV checked positively (only development and test are development; a missing NODE_ENV is production): use === 'development' || === 'test', or environment.isDevelopment()/isProtected(): ${hit}`,
    ),
    ...oldTokenPrefixHits(files).map((hit) => `the old token prefix (API tokens start with marmeon_): ${hit}`),
    ...DOC_TEXT_RULES.flatMap((rule) => textRuleHits(files, rule).map((hit) => `${rule.what} ${textRuleWhere(hit)} (${rule.why}): ${hit}`)),
    ...runtimeStringHits(files).map((hit) => `the framework's messages speak to app developers (say what holds, not its decision or wave): ${hit}`),
    ...privateRecordHits(files).map((hit) => `no references to the private record (${PRIVATE_RECORD_RULES.find((rule) => rule.what === hit.split(': ')[1])?.why}): ${hit}`),
  ];
}

if (import.meta.main) {
  const problems = checkSource();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\ncheck:source: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    console.log(
      `check:source: no file or path says the old name (allowed: the company name); no app, stub, template or generator imports or installs ${ENGINE}; no package, template or app checks NODE_ENV against 'production' (or asks import.meta.env.DEV); no file says the old token prefix; no docs page is pending, and no reader's text compares Marmeon with another framework; no string of a package's code or launchers names a decision, a wave or another framework; no file outside the ${PENDING_AREAS.length} pending areas names a decision, a wave, a personal date or the maintainers' notes.`,
    );
  }
}
