/**
 * `pnpm check:source` — rules over the repository's own files, a part of `pnpm run ci`. Exit 1 names every hit. The rules: the
 * old name is gone, no Valibot outside a package's `src/`, `NODE_ENV` is checked positively, the old token prefix is gone, the
 * docs and the framework's messages speak to their readers, no reference to the private record, no mutant switched off without
 * a reason, no lint rule disabled without one, no import of a package's internal subpath outside `packages/<name>/src/`, every deprecation shows the way forward, no import of the query builder outside `@marmeon/database`.
 *
 * Each rule in full: CONTRIBUTING.md, "Rules over the source".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deprecationProblems, findDeprecations } from './deprecations.ts';
import { FROZEN_PATHS, oxc, type SourceFile } from './source-files.ts';

export type { SourceFile };

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
  // The company's website, as the footer, README.md, CONTRIBUTING.md and the docs link it.
  { pattern: new RegExp(`https://${OLD_NAME.toLowerCase()}code\\.de(?![\\w.-])`, 'g') },
];

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

/** The subpath of the framework's own packages, spelled in parts: this file holds no import of one either. */
export const INTERNAL = ['/', 'internal'].join('');
const INTERNAL_IMPORT = new RegExp(
  [
    `\\bfrom\\s+['"\`]@marmeon/[\\w-]+${INTERNAL}['"\`]`, // import … from (also export … from)
    `\\bimport\\s*\\(\\s*['"\`]@marmeon/[\\w-]+${INTERNAL}['"\`]`, // a dynamic import
    `\\brequire\\s*\\(\\s*['"\`]@marmeon/[\\w-]+${INTERNAL}['"\`]`,
    `^\\s*import\\s+['"\`]@marmeon/[\\w-]+${INTERNAL}['"\`]`, // a bare import
  ].join('|'),
  'm',
);

/** Rule 9: every import of a package's internal subpath outside `packages/<name>/src/` — it is not API (docs/package-development.md). */
export function internalImportHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!CODE.test(path) || /^packages\/[^/]+\/src\//.test(path) || !INTERNAL_IMPORT.test(text)) continue;
    text.split('\n').forEach((line, index) => {
      if (INTERNAL_IMPORT.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return hits;
}

/** The query builder under `@marmeon/database`, spelled in parts like the engine: this file holds no import of it either. */
export const LIBRARY = ['kys', 'ely'].join('');
const LIBRARY_SPECIFIER = `${LIBRARY}(?:/[^'"\`]*)?`;
/** The import-shaped forms, for the code in docs: `from '…'` (also `import type`, `export … from`), `import('…')`, `require('…')`, a bare import, `declare module '…'`. */
const LIBRARY_IMPORT = new RegExp(
  [
    `\\bfrom\\s*(['"])${LIBRARY_SPECIFIER}\\1`,
    `\\bimport\\s*\\(\\s*(['"\`])${LIBRARY_SPECIFIER}\\2`,
    `\\brequire\\s*\\(\\s*(['"])${LIBRARY_SPECIFIER}\\3`,
    `^\\s*import\\s*(['"])${LIBRARY_SPECIFIER}\\4`,
    `\\bdeclare\\s+module\\s*(['"])${LIBRARY_SPECIFIER}\\5`,
  ].join('|'),
  'gm',
);
/**
 * Code files: the specifier in any quoted form — it also catches `import(name)` behind a constant, `createRequire(…)('…')`,
 * `import.meta.resolve('…')` and `/// <reference types="…" />`. A template literal counts only as the argument of a call or
 * after `from`, so a comment that names the package in backticks stays allowed.
 */
const LIBRARY_QUOTED = new RegExp(`(['"])${LIBRARY_SPECIFIER}\\1|(?:\\(|\\bfrom)\\s*\`${LIBRARY_SPECIFIER}\``, 'g');
/** Where the import of the library is shown to an app: docs pages and READMEs of packages, apps and examples (UPGRADING.md may show the old import). */
const LIBRARY_TEXT = /^(?:docs\/[^/]+|README|(?:packages|apps|examples)\/[^/]+\/README)\.md$/;
/** The manifests of the repository root and of the framework's packages: only `@marmeon/database` lists the query builder. */
const PACKAGE_MANIFEST = /^(?:package\.json|packages\/(?!database\/)[^/]+\/package\.json)$/;
/** The one place that imports the query builder. */
const LIBRARY_HOME = /^packages\/database\/src\//;
/** The edits of an example: their `replace` text becomes app code. */
const EXAMPLE_EDITS = /^examples\/[^/]+\/edits\.json$/;
/** A key of `overrides`, `resolutions`: `kysely`, `kysely@<range>`, `parent>kysely`, `a/kysely` (yarn). */
const LIBRARY_KEY = new RegExp(`(?:^|[>/])${LIBRARY}(?:@|$)`);
const LIBRARY_ALIAS = new RegExp(`^(?:npm:|github:[^/]+/)${LIBRARY}(?:[@#]|$)`);

/** The manifest's ways to install the library: a dependency, an alias of it, a bundled one, an override of it. */
function libraryInManifest(manifest: Record<string, unknown>): string[] {
  const found: string[] = [];
  const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const walk = (field: string, value: Record<string, unknown>, nested: boolean) => {
    for (const [key, entry] of Object.entries(value)) {
      if (key === LIBRARY || (nested && LIBRARY_KEY.test(key))) found.push(`${field} lists ${LIBRARY}`);
      else if (typeof entry === 'string' && LIBRARY_ALIAS.test(entry)) found.push(`${field} aliases ${LIBRARY} as ${key}`);
      else if (nested && entry && typeof entry === 'object') walk(`${field}.${key}`, asRecord(entry), nested);
    }
  };
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) walk(field, asRecord(manifest[field]), false);
  walk('overrides', asRecord(manifest.overrides), true);
  walk('resolutions', asRecord(manifest.resolutions), true);
  walk('pnpm.overrides', asRecord(asRecord(manifest.pnpm).overrides), true);
  for (const field of ['bundleDependencies', 'bundledDependencies']) {
    if (Array.isArray(manifest[field]) && (manifest[field] as unknown[]).includes(LIBRARY)) found.push(`${field} lists ${LIBRARY}`);
  }
  return found;
}

/** The text of a markdown file with everything outside fenced code blocks blanked (line numbers stay). */
function fencedCode(text: string): string {
  let inside = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inside = !inside;
        return '';
      }
      return inside ? line : '';
    })
    .join('\n');
}

/** The (1-based) lines on which `pattern` matches in `text` — a match is on the line of its first non-blank character. */
function matchedLines(text: string, pattern: RegExp): number[] {
  const lines = new Set<number>();
  for (const match of text.matchAll(pattern)) lines.add(text.slice(0, match.index + match[0].search(/\S/)).split('\n').length);
  return [...lines];
}

/**
 * Rule 11: every import of the library outside `packages/database/src/`, in the code of docs and READMEs, in the edits of an
 * example, and every manifest but database's own that installs it — `path:line: text`.
 */
export function libraryImportHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  const say = (text: string, line: number) => text.split('\n')[line - 1]!.trim().slice(0, 160);
  for (const { path, text } of files) {
    if (APP_MANIFEST.test(path) || PACKAGE_MANIFEST.test(path)) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // not JSON: the template's own checks catch it
      }
      for (const found of libraryInManifest(manifest)) hits.push(`${path}: ${found} — only @marmeon/database depends on it`);
      continue;
    }
    if (EXAMPLE_EDITS.test(path)) {
      let edits: unknown;
      try {
        edits = JSON.parse(text);
      } catch {
        continue;
      }
      (Array.isArray(edits) ? edits : []).forEach((edit: { file?: string; replace?: unknown }, index) => {
        if (typeof edit?.replace !== 'string') return;
        for (const line of matchedLines(edit.replace, LIBRARY_QUOTED)) hits.push(`${path}: edit ${index + 1} (${edit.file ?? '?'}): ${say(edit.replace, line)}`);
      });
      continue;
    }
    if (LIBRARY_TEXT.test(path)) {
      const code = fencedCode(text);
      for (const line of matchedLines(code, LIBRARY_IMPORT)) hits.push(`${path}:${line}: ${say(text, line)}`);
      continue;
    }
    if (!CODE.test(path) || LIBRARY_HOME.test(path)) continue;
    for (const line of matchedLines(text, LIBRARY_QUOTED)) hits.push(`${path}:${line}: ${say(text, line)}`);
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
 * Code people run or copy — a package's sources and the stubs it writes into apps, the starter's template, the apps, the examples — not tests
 * and fixtures.
 */
const PACKAGE_CODE = /^(?:packages\/[^/]+\/(?:src|stubs)\/|packages\/create-marmeon\/template\/|apps\/[^/]+\/|examples\/)(?!.*(?:\.test\.|\.type-test\.|__fixtures__\/))/;

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
/** The examples: what the demos add to a new app — read and copied like the apps' code, and run by `pnpm pack:smoke`. */
const EXAMPLES = /^examples\//;
/** The website's own pages (landing, marketing text): they speak to readers like the docs do. */
const SITE_TEXTS = /^apps\/website\/modules\/site\/.+\.tsx?$/;
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
    why: 'every page is written — write it, or take it out of apps/website/docs.config.ts and docs/',
  },
  {
    what: 'a comparison with another framework',
    pattern: /\b(?:Laravel|Breeze|Inertia|Rails|Django|Symfony|AdonisJS|NestJS|Next\.js|Nuxt)\b/,
    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES, APP_TEXTS, SITE_TEXTS, EXAMPLES],
    why: 'describe Marmeon as it is — a reader may know no other framework',
  },
];

/** Where a hit of rule 5 (`path:line: text`, or a path) stands, for its message: the docs, what every new app copies, an app's texts, or the website's own pages. */
export function textRuleWhere(hit: string): string {
  const path = hit.replace(/:\d+: [\s\S]*$/, '');
  if (APP_COPIES.test(path)) return 'in what every new app copies';
  if (SITE_TEXTS.test(path)) return 'on the website';
  if (EXAMPLES.test(path)) return 'in the examples';
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

/**
 * Rule 7: what points into the maintainers' private record — in every tracked file. A random value (a key, a token) can match
 * by chance: regenerate it. Only the lockfile's hashes, which cannot be regenerated, are left out (`WRITTEN`).
 */
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
    // A wave or a step — a `W` or "wave" and its number, each with its letter, a point release and a step — an id of a `G` or
    // `T`, one or two digits and a letter, and two words no file may say (spelled in parts below, so this file passes its own
    // rule); `W3C` is none.
    pattern: new RegExp(
      [
        String.raw`\b(?:W\d+[a-z]?(?:\.\d+[a-z]?)?(?:\s+step\s+\d+[a-z]?)?|[Ww]ave \d+[a-z]?(?:\s+step\s+\d+[a-z]?)?|[GT]\d{1,2}[a-z])\b`,
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

/** Why the rule behind a `privateRecordHits` hit exists (`path:line: what: text` → its `why`). */
export function privateRecordWhy(hit: string): string | undefined {
  return PRIVATE_RECORD_RULES.find((rule) => rule.what === hit.split(': ')[1])?.why;
}

/** Rule 7: every line that names the private record — `path:line: what: text`. */
export function privateRecordHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
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

/** A comment's text as the mutation tester reads a directive: the mutators end at the first character outside letters, commas and spaces; the reason is what follows a colon right there. */
const MUTATION_COMMENT = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
const MIN_REASON_WORDS = 3;

/**
 * Rule 8: every disable comment of the mutation tester in code names its reason (`: …`, at least three words); a disabled range
 * (without `next-line`) is restored later in the same file and never covers `all` — `path:line: problem`.
 */
export function mutationCommentHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!CODE.test(path) || !text.includes('Stryker')) continue;
    const { comments, errors } = oxc().parseSync(path, text);
    if (errors.length > 0) throw new Error(`${path}: oxc-parser cannot read it: ${errors[0]!.message}`);
    const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
    const open: { line: number; mutators: Set<string> }[] = [];
    for (const comment of comments) {
      const found = MUTATION_COMMENT.exec(comment.value);
      if (!found) continue;
      const [, action, nextLine, list = '', reason = ''] = found;
      const mutators = list.split(',').map((name) => name.trim()).filter(Boolean);
      const line = lineOf(comment.start);
      const where = `${path}:${line}`;
      if (action === 'restore') {
        for (const range of open) for (const name of mutators) range.mutators.delete(name);
        if (mutators.includes('all')) open.length = 0;
        continue;
      }
      if (reason.trim().split(/\s+/).filter(Boolean).length < MIN_REASON_WORDS) {
        hits.push(`${where}: a disabled mutant needs a reason of at least ${MIN_REASON_WORDS} words right after a colon behind the mutators — say why it changes nothing`);
      }
      if (nextLine) continue;
      if (mutators.includes('all')) hits.push(`${where}: a disabled range must name its mutators, not all — disable the lines that need it, one by one`);
      else open.push({ line, mutators: new Set(mutators) });
    }
    for (const { line, mutators } of open) {
      if (mutators.size > 0) hits.push(`${path}:${line}: the range disabled for ${[...mutators].join(', ')} is never restored — close it with a restore comment`);
    }
  }
  return hits;
}

const LINT_DISABLE = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=\s|$)([\s\S]*)$/;

/**
 * Rule 13: every lint-disable comment in code (`eslint-disable` or `oxlint-disable`, with `-next-line`, `-line` or as a range)
 * gives its reason after ` -- `, at least three words — why the rule is wrong for this line. `path:line: problem`.
 */
export function lintDisableHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (!CODE.test(path) || !/(?:eslint|oxlint)-disable/.test(text)) continue;
    const { comments, errors } = oxc().parseSync(path, text);
    if (errors.length > 0) throw new Error(`${path}: oxc-parser cannot read it: ${errors[0]!.message}`);
    for (const comment of comments) {
      const found = LINT_DISABLE.exec(comment.value);
      if (!found) continue;
      const reason = found[1]!.split(/\s--\s/).slice(1).join(' -- ');
      if (reason.trim().split(/\s+/).filter(Boolean).length >= MIN_REASON_WORDS) continue;
      hits.push(`${path}:${text.slice(0, comment.start).split('\n').length}: a lint-disable comment needs a reason of at least ${MIN_REASON_WORDS} words after " -- " — say why the rule is wrong here`);
    }
  }
  return hits;
}

/** Test files of every kind — the framework's, the stubs and the template, the examples — and the Vite and Vitest configurations. */
const TEST_FILE = /(?:\.test\.tsx?$|(?:^|\/)vite(?:st)?\.config\.[cm]?[jt]s$)/;
/** The names a test file starts a test, a suite or a fixture set from. */
const TEST_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite', 'bench']);
/** Functions that take the configuration of the tests as an object. */
const CONFIG_FUNCTIONS = new Set(['defineConfig', 'defineProject', 'defineWorkspace', 'mergeConfig']);

interface AstNode {
  type?: string;
  start?: number;
  [key: string]: unknown;
}

/** The identifier a call chain starts from: `it` in `it.skipIf(x)('a', …)`, `vi` in `vi.setConfig(…)`. */
function chainRoot(node: AstNode | undefined): string | undefined {
  let current = node;
  while (current) {
    if (current.type === 'Identifier') return current.name as string;
    current = (current.type === 'MemberExpression' ? current.object : current.type === 'CallExpression' ? current.callee : undefined) as AstNode | undefined;
  }
  return undefined;
}

/** The local names bound to the exports of Vitest in one file: the API's own names, and every alias a file gives them. */
interface ApiNames {
  tests: Set<string>;
  configs: Set<string>;
  vi: Set<string>;
}

const apiNames = (): ApiNames => ({ tests: new Set(TEST_FUNCTIONS), configs: new Set(CONFIG_FUNCTIONS), vi: new Set(['vi']) });

/** Which set the export `name` belongs to. */
function setOf(names: ApiNames, name: string): Set<string> | undefined {
  return names.tests.has(name) ? names.tests : names.configs.has(name) ? names.configs : names.vi.has(name) ? names.vi : undefined;
}

/** Whether a call's callee belongs to the API of tests and their configuration: `it`, `describe.each(…)`, `test.extend`, `vi.setConfig`, `defineConfig`, … */
function isTestApi(callee: AstNode, names: ApiNames): boolean {
  const root = chainRoot(callee);
  if (root === undefined) return false;
  if (names.tests.has(root) || names.configs.has(root)) return true;
  return names.vi.has(root) && callee.type === 'MemberExpression' && (callee.property as AstNode).name === 'setConfig';
}

/** Whether `key` names `retry`: an identifier, a string, or a computed string or template without a hole. */
function isRetryKey(property: AstNode): boolean {
  const key = property.key as AstNode | undefined;
  if (!key) return false;
  if (key.type === 'Identifier') return !property.computed && key.name === 'retry';
  if (key.type === 'Literal') return key.value === 'retry';
  return key.type === 'TemplateLiteral' && (key.expressions as unknown[]).length === 0 && (key.quasis as { value: { cooked?: string } }[])[0]?.value.cooked === 'retry';
}

const isZero = (node: AstNode | undefined) => node?.type === 'Literal' && node.value === 0;

/** Whether the value of a `retry` property is the literal `0` or `{ count: 0 }` — the only value that retries nothing and can be read. */
function retriesNothing(property: AstNode): boolean {
  const value = property.value as AstNode | undefined;
  if (isZero(value)) return true;
  if (value?.type !== 'ObjectExpression') return false;
  const members = value.properties as AstNode[];
  return members.every((member) => member.type === 'Property' && (member.key as AstNode | undefined)?.name === 'count' && isZero(member.value as AstNode));
}

const FUNCTION_LIKE = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
/** An argument of a test call that cannot hold `retry` unseen: a function, a literal, a template, an array, an object without a spread. */
const isPlain = (node: AstNode) =>
  FUNCTION_LIKE.has(node.type!) || node.type === 'Literal' || node.type === 'TemplateLiteral' || node.type === 'ArrayExpression' || (node.type === 'ObjectExpression' && !(node.properties as AstNode[]).some((member) => member.type === 'SpreadElement'));

/**
 * Rule 12: no test is retried — and nothing that hides a retry from this rule either. In a test file or a Vite or Vitest
 * configuration, every property `retry` is a hit (written as an identifier, a string or a computed string) unless its value is the
 * literal `0` or `{ count: 0 }`; so are `.retry(…)` on `it`/`test`/`describe`, `--retry` in a `package.json` script, an options
 * argument of a test call or of `vi.setConfig()` that is not an object literal (a variable, a call) or spreads another object, and a
 * name that takes over `it`/`test` (`const t = it`, `t = it`; an alias in an import or a destructuring counts as the export itself).
 * In a test file (not in a configuration) one exception holds: an object that is directly an argument of a call or a `new` outside
 * the API of tests and their configuration (`expect(config).toMatchObject({ retry: 3000 })`) is a `retry` of something else.
 * `retryAfterSeconds`, strings, comments and `queue.retry(job)` are none. The rule catches a retry written by accident; it is no barrier
 * against someone who sets out to get around it. `path:line: text`.
 */
export function retriedTestHits(files: Iterable<SourceFile>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (/(?:^|\/)package\.json$/.test(path)) {
      text.split('\n').forEach((line, index) => {
        if (/--retry\b/.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
      continue;
    }
    if (!TEST_FILE.test(path)) continue;
    const { program, errors } = oxc().parseSync(path, text);
    if (errors.length > 0) throw new Error(`${path}: oxc-parser cannot read it: ${errors[0]!.message}`);
    const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
    const hit = (node: AstNode) => hits.push(`${path}:${lineOf(node.start ?? 0)}: ${text.split('\n')[lineOf(node.start ?? 0) - 1]!.trim().slice(0, 160)}`);
    const parentOf = new WeakMap<object, AstNode>();
    const names = apiNames();
    const isConfig = /(?:^|\/)vite(?:st)?\.config\.[cm]?[jt]s$/.test(path);
    const walk = (node: unknown, each: (found: AstNode) => void): void => {
      if (Array.isArray(node)) return node.forEach((child) => walk(child, each));
      if (node === null || typeof node !== 'object') return;
      const found = node as AstNode;
      each(found);
      for (const [key, child] of Object.entries(found)) {
        if (key === 'parent') continue;
        for (const inner of Array.isArray(child) ? child : [child]) if (inner !== null && typeof inner === 'object') parentOf.set(inner, found);
        walk(child, each);
      }
    };
    // Aliases first, in any order they are written: `import { it as t }`, `const { it: t } = …`, `const t = it`, `t = it`.
    const bind = (local: AstNode | undefined, exported: string | undefined) => {
      const set = exported === undefined ? undefined : setOf(names, exported);
      if (set && local?.type === 'Identifier') set.add(local.name as string);
    };
    const taken: AstNode[] = [];
    walk(program, (found) => {
      if (found.type === 'ImportSpecifier') bind(found.local as AstNode, ((found.imported as AstNode).name ?? (found.imported as AstNode).value) as string);
      if (found.type === 'Property' && parentOf.get(found)?.type === 'ObjectPattern' && (found.value as AstNode | undefined)?.type === 'Identifier' && (found.key as AstNode | undefined)?.type === 'Identifier') bind(found.value as AstNode, (found.key as AstNode).name as string);
      const [target, source] = found.type === 'VariableDeclarator' ? [found.id, found.init] : found.type === 'AssignmentExpression' ? [found.left, found.right] : [];
      const root = source ? chainRoot(source as AstNode) : undefined;
      if (root !== undefined && setOf(names, root) === names.tests) {
        bind(target as AstNode, root);
        if ((source as AstNode).type !== 'CallExpression') taken.push(found); // `it.skipIf(x)` and `test.extend({})` make a new test function: bound, not refused
      }
    });
    for (const found of taken) hit(found);
    walk(program, (found) => {
      if (found.type === 'Property' && isRetryKey(found) && !retriesNothing(found)) {
        const call = parentOf.get(parentOf.get(found)!); // the call the object literal is an argument of, if it is
        const outside =
          !isConfig &&
          (call?.type === 'CallExpression' || call?.type === 'NewExpression') &&
          !(call.type === 'CallExpression' && isTestApi(call.callee as AstNode, names)) &&
          (call.arguments as AstNode[]).includes(parentOf.get(found)!);
        if (!outside) hit(found);
      }
      if (found.type === 'CallExpression') {
        const callee = found.callee as AstNode;
        const root = chainRoot(callee) ?? '';
        const args = found.arguments as AstNode[];
        if (callee.type === 'MemberExpression' && (callee.property as AstNode).name === 'retry' && names.tests.has(root)) hit(found);
        if (names.vi.has(root) && callee.type === 'MemberExpression' && (callee.property as AstNode).name === 'setConfig' && args[0] && !isPlain(args[0])) hit(found);
        const extend = callee.type === 'MemberExpression' && (callee.property as AstNode).name === 'extend';
        if (names.tests.has(root) && !extend && args.length >= 2) {
          // Behind the callback a name is the timeout (`it('a', fn, SLOW)`): Vitest takes nothing but a number there.
          const afterCallback = FUNCTION_LIKE.has(args[1]!.type!) ? args[2] : undefined;
          const options = args.slice(1).filter((arg) => !isPlain(arg) && !(arg === afterCallback && ['Identifier', 'MemberExpression', 'BinaryExpression'].includes(arg.type!)));
          // With two arguments a lone name is the callback; with three, one that is no function or literal may hold the options.
          if (options.length > 0 && (args.length >= 3 || options.some((arg) => arg.type === 'SpreadElement' || arg.type === 'ObjectExpression'))) hit(found);
        }
      }
    });
  }
  return hits;
}

/** The repository's files as git sees them: tracked, and new ones that are not ignored — text only, as they are on disk; the frozen paths are left out. */
export function repositoryFiles(repository: string = root): SourceFile[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${repository}: ${listed.stderr}`);
  const files: SourceFile[] = [];
  for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
    if (FROZEN_PATHS.some((frozen) => path.startsWith(frozen))) continue;
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

/** The version of `@marmeon/core` in `repository` (this repository's when it has none) — the one every package is released at. */
function coreVersion(repository: string): string {
  const manifest = join(repository, 'packages/core/package.json');
  return (JSON.parse(readFileSync(existsSync(manifest) ? manifest : join(root, 'packages/core/package.json'), 'utf8')) as { version: string }).version;
}

/** Every rule over `repository`; [] when all hold. */
export function checkSource(repository: string = root): string[] {
  const files = repositoryFiles(repository);
  return [
    ...oldNameHits(files).map((hit) => `the old name: ${hit}`),
    ...engineHits(files).map((hit) => `no ${ENGINE} in apps, stubs and templates: ${hit}`),
    ...internalImportHits(files).map((hit) => `the internal subpath of a package is not API (decide access with everyone or a check; docs/package-development.md): ${hit}`),
    ...libraryImportHits(files).map(
      (hit) =>
        `only @marmeon/database depends on Kysely; take the builder and its types from it (sql, Kysely, Transaction, Connection, SelectQuery, ColumnReference …) — the framework pins its version; docs/releases.md#libraries-the-framework-builds-on: ${hit}`,
    ),
    ...negativeEnvHits(files).map(
      (hit) => `NODE_ENV checked positively (only development and test are development; a missing NODE_ENV is production): use === 'development' || === 'test', or environment.isDevelopment()/isProtected(): ${hit}`,
    ),
    ...oldTokenPrefixHits(files).map((hit) => `the old token prefix (API tokens start with marmeon_): ${hit}`),
    ...DOC_TEXT_RULES.flatMap((rule) => textRuleHits(files, rule).map((hit) => `${rule.what} ${textRuleWhere(hit)} (${rule.why}): ${hit}`)),
    ...runtimeStringHits(files).map((hit) => `the framework's messages speak to app developers (say what holds, not its decision or wave): ${hit}`),
    ...mutationCommentHits(files).map((hit) => `mutation testing (a disabled mutant hides the test gap it would show; CONTRIBUTING.md › Rules over the source): ${hit}`),
    ...lintDisableHits(files).map((hit) => `a disabled lint rule hides what it would show (CONTRIBUTING.md › Rules over the source): ${hit}`),
    ...retriedTestHits(files).map(
      (hit) => `a test that is retried measures noise — prove the property deterministically, or move a measurement of time into a *.timing.test.ts (CONTRIBUTING.md › Rules over the source): ${hit}`,
    ),
    ...privateRecordHits(files).map((hit) => `no references to the private record (${privateRecordWhy(hit)}): ${hit}`),
    ...deprecationProblems(findDeprecations(files), coreVersion(repository)).map(
      (problem) => `every deprecation shows the way forward (a replacement, docs/<page>.md#<anchor>, "Removed in x.y"; CONTRIBUTING.md › Rules over the source): ${problem}`,
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
    console.log(
      `check:source: no file or path says the old name (allowed: the company name and its website's URL); no app, stub, template or generator imports or installs ${ENGINE}; no package, template or app checks NODE_ENV against 'production' (or asks import.meta.env.DEV); no file says the old token prefix; no docs page is pending, and no reader's text compares Marmeon with another framework; no string of a package's code or launchers names a decision, a wave or another framework; no file names a decision, a wave, a personal date or the maintainers' notes; no mutant is disabled without a reason or left disabled; every lint-disable comment says why; no test is retried; nothing outside a package's src/ imports an internal subpath; every deprecation names a replacement, a docs page and the version that removes it; nothing but @marmeon/database imports or installs ${LIBRARY}.`,
    );
  }
}
