import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stringLiterals } from '@marmeon/core/internal';
import { INTERNAL_MESSAGE } from '../commands/make-lint-config.ts';
import type { CheckProblem } from './report.ts';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Left out below the app root only (`modules/storage/` is an app's own code); `node_modules` is left out everywhere. */
const SKIPPED_AT_ROOT = new Set(['dist', 'storage', 'coverage']);

/** What names a package's `./internal` subpath, its `dist` or its `src`: the module specifiers the framework does not offer. */
const FORBIDDEN: readonly RegExp[] = [
  /^@marmeon\/[^/]+\/internal(?:[/?#]|$)/,
  /^marmeon\/internal(?:[/?#]|$)/,
  /^@marmeon\/[^/]+\/(?:dist|src)(?:[/?#]|$)/,
  /^marmeon\/(?:dist|src)(?:[/?#]|$)/,
];

/** Said for a path that is no `/internal` specifier: it reaches into the installed package. */
export const INSTALLED_MESSAGE =
  "A package's `dist` or `src`, or a path into `node_modules`, is the framework's own code, not API — it can change in any release. Import the package by its name; if you need something only the file has, open an issue.";

/**
 * Whether a string, as a module specifier or path (`/`-separated, case-insensitive below `node_modules`), points into the
 * framework: after the first `node_modules` segment, any directory named `@marmeon` or `marmeon`, or anything under `.vite`
 * that mentions marmeon (the pre-bundled `.vite/deps/@marmeon_core_internal.js`). One pass over the segments.
 */
function forbidden(value: string): string | undefined {
  const path = value.replaceAll('\\', '/');
  if (FORBIDDEN.some((pattern) => pattern.test(path))) return /\/internal(?:[/?#]|$)/.test(path) ? INTERNAL_MESSAGE : INSTALLED_MESSAGE;
  const segments = path.split('/');
  const modules = segments.findIndex((segment) => segment.toLowerCase() === 'node_modules');
  if (modules === -1) return undefined;
  for (let index = modules + 1; index < segments.length - 1; index++) {
    const segment = segments[index]!.toLowerCase();
    if (segment === '@marmeon' || segment === 'marmeon') return INSTALLED_MESSAGE;
    if (segment === '.vite' && path.toLowerCase().includes('marmeon')) return INSTALLED_MESSAGE;
  }
  return undefined;
}

/**
 * Every place in the app that names a framework internal: any string literal of a source file (import and export sources,
 * `import()`, `require()`, `vi.mock()`, `import type`, a template without an expression), the `paths` of `tsconfig*.json`
 * and the `imports` of `package.json`. Independent of `.oxlintrc.json`. Not found: a specifier built from parts
 * (`'@marmeon/' + 'core/internal'`), files that do not parse (tsc reports them), file types other than JS and TS.
 * See docs/check.md#imports-of-framework-internals.
 */
export function internalImports(root: string): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const path of filesUnder(root, root)) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // Every pattern contains "marmeon"; a backslash is the only way to write it without spelling it.
    if (!/marmeon|\\/i.test(text)) continue;
    const file = relative(root, path).split('\\').join('/');
    let literals: { value: string; line: number; column: number }[] | undefined;
    if (SOURCE.test(name)) {
      literals = stringLiterals(text, name);
    } else if (/^tsconfig.*\.json$/.test(name)) {
      literals = jsonLiterals(text, name);
    } else if (name === 'package.json') {
      const span = importsSpan(text);
      literals = span && jsonLiterals(text, name)?.filter((literal) => literal.line >= span.from.line && literal.line <= span.to.line && (literal.line !== span.from.line || literal.column >= span.from.column) && (literal.line !== span.to.line || literal.column <= span.to.column));
    }
    for (const literal of literals ?? []) {
      const message = forbidden(literal.value);
      if (message === undefined) continue;
      problems.push({
        severity: 'error',
        message,
        file,
        line: literal.line,
        column: literal.column,
        rule: 'marmeon(no-internal-imports)',
        docs: 'docs/check.md#imports-of-framework-internals',
      });
    }
  }
  return problems;
}

/**
 * The files to read, depth first in name order: no `node_modules`, no dot directory, no symlink, and `dist`, `storage` and
 * `coverage` only at the app root. A directory that cannot be read is skipped.
 */
function filesUnder(root: string, directory: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name).split('\\').join('/');
    if (entry.isDirectory()) {
      const skipped = entry.name === 'node_modules' || entry.name.startsWith('.') || (directory === root && SKIPPED_AT_ROOT.has(entry.name));
      if (!skipped) for (const file of filesUnder(root, path)) files.push(file);
    } else if (entry.isFile() && (SOURCE.test(entry.name) || /^tsconfig.*\.json$/.test(entry.name) || entry.name === 'package.json')) {
      files.push(path);
    }
  }
  return files;
}

/** The strings of a JSON file with comments and trailing commas (tsconfig), read as the object literal it is. */
function jsonLiterals(text: string, name: string): { value: string; line: number; column: number }[] | undefined {
  const found = stringLiterals(`(${text}\n)`, `${name}.js`);
  return found?.map((literal) => (literal.line === 1 ? { ...literal, column: literal.column - 1 } : literal));
}

/** Where the top-level `imports` value of a package.json starts and ends (1-based), found without trusting a lookalike inside a string. */
function importsSpan(text: string): { from: { line: number; column: number }; to: { line: number; column: number } } | undefined {
  let expected: string;
  try {
    const imports = (JSON.parse(text) as { imports?: unknown }).imports;
    if (imports === undefined) return undefined;
    expected = JSON.stringify(imports);
  } catch {
    return undefined; // Not JSON: npm refuses it too.
  }
  for (const match of text.matchAll(/"imports"\s*:\s*/g)) {
    const from = match.index + match[0].length;
    let depth = 0;
    let inString = false;
    for (let index = from; index < text.length; index++) {
      const character = text[index]!;
      if (inString) {
        if (character === '\\') index++;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') depth--;
      if (depth === 0 && !inString && index > from) {
        try {
          if (JSON.stringify(JSON.parse(text.slice(from, index + 1))) !== expected) break;
        } catch {
          break;
        }
        return { from: position(text, from), to: position(text, index) };
      }
    }
  }
  return undefined;
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}
