/**
 * `pnpm api:usage <entry>` — who imports each export of a package entry point? The input for deciding what stays public, moves to
 * `./testing` or `./internal`, or stops being exported (CONTRIBUTING.md, "The API snapshot").
 *
 *   pnpm api:usage @marmeon/core             # one section per suggestion: keep, testing, internal, drop
 *   pnpm api:usage @marmeon/core --files     # and the files that import each name
 *   pnpm api:usage @marmeon/core --json      # the same as JSON
 *
 * The names come from the checked-in `api.md` (no build needed), the imports from the repository's files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.md`).
 * The suggestion is only a first guess: whether a public signature names an export, or an app implements it, the reader checks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSnapshot, type ApiItem } from './api-snapshot.ts';
import { repositoryFiles } from './check-source.ts';
import type { SourceFile } from './source-files.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export type Suggestion = 'keep' | 'testing' | 'internal' | 'drop';

export interface NameUsage {
  readonly name: string;
  readonly suggestion: Suggestion;
  /** Why — in a few words. */
  readonly reason: string;
  /** `docs/` and READMEs. */
  readonly docs: string[];
  /** Docs that name it in code or inline code without importing it: `useBlocker({ … })` in a block, `` `createApplication(definition)` `` in prose. */
  readonly mentioned: string[];
  /** `apps/` and `examples/`, without tests. */
  readonly apps: string[];
  /** The starter's template and the packages' `stubs/`: code that is copied into apps. */
  readonly kit: string[];
  /** The code of other packages, by package directory. */
  readonly siblings: Record<string, string[]>;
  /** The `bin/` launchers of other packages, by package directory: they may not import an internal subpath. */
  readonly launchers: Record<string, string[]>;
  /** Tests anywhere (and fixtures). */
  readonly tests: string[];
  /** The entry points of other packages that re-export the name. */
  readonly reexportedBy: string[];
  /** The public declarations of other entries (of this or another package) whose snapshot text names it, as `<entry> <item>`: it stays public. */
  readonly namedBy: string[];
  /** The declarations of this entry that name it: without the export it would show up as `Referenced, not exported`. */
  readonly namedHere: string[];
}

export interface EntryUsage {
  readonly entry: string;
  readonly names: NameUsage[];
  /** Files that import the entry as a whole (`import * as`, `export *`, `import()`): the names they use are not known. */
  readonly wholeImports: string[];
}

export interface Import {
  readonly specifier: string;
  /** The exported names the statement takes; `undefined` for the entry as a whole. */
  readonly names: readonly string[] | undefined;
  /** The local name of `import * as ns from 'x'` and `const ns = await import('x')`: its uses show which names are taken. */
  readonly namespace?: string;
}

/** `import … from 'x'` and `export … from 'x'`, over several lines too. The clause has no `=`, quote or bracket: prose and code in between do not match. */
const STATEMENT = /\b(?:import|export)\s+(?:type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
/** `import('x')`, with the member when it is read directly: `import('x').Foo`. */
const DYNAMIC = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)(?:\.([\w$]+))?/g;

/** `const { a, b: c } = await import('x')` and `= require('x')`: the names are taken from the module like a named import. */
const DESTRUCTURED = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*(['"])([^'"\n]+)\2\s*\)/g;
/** `require('x')`, with the member when it is read directly. */
const REQUIRE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)(?:\.([\w$]+))?/g;
/** Files that are no source of ours: build output, installed packages, what the framework generates. */
const NOT_SOURCE = /(^|\/)(?:dist|node_modules|\.marmeon)\//;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|md)$/;

/** The name a `{ … }` item takes from the module: `type A as B` is `A`. */
function importedName(part: string): string {
  return part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
}

/** The imports and re-exports in a file's text (a Markdown page's code blocks included). */
export function importsOf(text: string): Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    const clause = match[1]!.trim();
    const specifier = match[3]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces ? braces[1]!.split(',').map(importedName).filter((name) => name !== '') : [];
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    const namespace = match[0].startsWith('import') ? /^\*\s*as\s+([\w$]+)$/.exec(outside)?.[1] : undefined;
    if (outside.startsWith('*')) found.push({ specifier, names: undefined, ...(namespace !== undefined && { namespace }) });
    else if (/^[\w$]+$/.test(outside)) names.push('default');
    if (names.length > 0) found.push({ specifier, names });
  }
  // A destructured import is read as names; what is left of the text is checked for whole and member imports.
  const rest = text.replace(DESTRUCTURED, (_, clause: string, _quote: string, specifier: string) => {
    // `a: b` and `a = 1` take `a`; a `...rest` or a computed key takes the module as a whole.
    const parts = clause.split(',').map((part) => part.trim().split(/\s*[:=]\s*/)[0]!.trim()).filter((part) => part !== '');
    const whole = parts.some((part) => !/^[\w$]+$/.test(part));
    found.push({ specifier, names: whole || parts.length === 0 ? undefined : parts });
    return '';
  });
  for (const regexp of [DYNAMIC, REQUIRE]) {
    for (const match of rest.matchAll(regexp)) {
      const namespace = match[3] ? undefined : /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?$/.exec(rest.slice(0, match.index))?.[1];
      found.push({ specifier: match[2]!, names: match[3] ? [match[3]] : undefined, ...(namespace !== undefined && { namespace }) });
    }
  }
  return found;
}

export interface NamespaceUse {
  /** The members read as `ns.Name` and the names taken by `const { A } = ns`. */
  readonly names: ReadonlySet<string>;
  /** `ns` is used in another way (passed on, spread, `ns[expr]`): the names it provides are not known. */
  readonly whole: boolean;
}

/** How a file uses the namespace `ns` it imported: named members, or as a whole. Any other occurrence of `ns` counts as a whole use. */
export function namespaceUseOf(source: string, ns: string): NamespaceUse {
  const text = source.replace(/(['"])[^'"\n]*\1/g, "''"); // a module specifier may contain the name: '@marmeon/demo'
  const names = new Set<string>();
  // Not a member of something else (`a.ns`), but a spread (`...ns`) is the namespace itself.
  const standalone = `(?<![\\w$])(?<!(?<!\\.)\\.)${ns.replaceAll('$', '\\$')}(?![\\w$])`;
  let accounted = 1; // the declaration
  let whole = false;
  for (const match of text.matchAll(new RegExp(`${standalone}\\??\\.([\\w$]+)`, 'g'))) {
    names.add(match[1]!);
    accounted += 1;
  }
  for (const match of text.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${standalone}`, 'g'))) {
    // `a: b` and `a = 1` take `a`; a `...rest` or a computed key takes the namespace as a whole.
    const parts = match[1]!.split(',').map((part) => part.trim().split(/\s*[:=]\s*/)[0]!.trim()).filter((part) => part !== '');
    if (parts.some((part) => !/^[\w$]+$/.test(part))) whole = true;
    for (const part of parts) names.add(part);
    accounted += 1;
  }
  const occurrences = [...text.matchAll(new RegExp(standalone, 'g'))].length;
  return { names, whole: whole || names.size === 0 || occurrences > accounted };
}

const TEST_FILE = /\.test\.|\.type-test\.|(^|\/)__fixtures__\//;
const SHIPPED = /^packages\/[^/]+\/(?:stubs|template)\//;

type Kind = { kind: 'docs' | 'apps' | 'kit' | 'test' } | { kind: 'sibling' | 'launcher'; directory: string };

/** Which group a file belongs to; `undefined` for what does not count (the package's own code and tests, scripts, the root). */
function classify(path: string, ownDirectory: string): Kind | undefined {
  if (path.startsWith('scripts/') || NOT_SOURCE.test(path)) return undefined;
  const own = path.startsWith(`packages/${ownDirectory}/`);
  const shipped = SHIPPED.test(path);
  if (TEST_FILE.test(path)) return own && !shipped ? undefined : { kind: 'test' };
  if (shipped) return { kind: 'kit' };
  if (path.endsWith('.md')) return path.startsWith('docs/') || /(^|\/)README\.md$|^UPGRADING\.md$/.test(path) ? { kind: 'docs' } : undefined;
  if (path.startsWith('apps/') || path.startsWith('examples/')) return { kind: 'apps' };
  const directory = /^packages\/([^/]+)\/src\//.exec(path)?.[1];
  if (directory !== undefined && !own) return { kind: 'sibling', directory };
  // A `bin/` launcher is framework code, but check:source lets only a package's `src/` import an internal subpath.
  const launcher = /^packages\/([^/]+)\/bin\//.exec(path)?.[1];
  if (launcher !== undefined && !own) return { kind: 'launcher', directory: launcher };
  return undefined;
}

/** A Fake, a clock or another double an app's tests use, which belongs in `./testing`. */
const TEST_DOUBLE = /Fake$|^Fake[A-Z]|^TestClock$|^Test[A-Z]/;

/**
 * The names among `known` that a page's inline code or `ts`/`tsx` blocks use as an identifier: inline code that is the name or starts
 * with `Name(`, `Name<`, `Name.`, ``Name` ``, `<Name` or `new Name`; in a block any word followed by `(`, `<` or `.`, or after `new`, `extends`,
 * `implements` or `<` (a JSX tag). A word in prose or in the middle of inline code does not count, nor does a name the page imports
 * from another specifier (`elsewhere`).
 */
export function mentionsOf(text: string, known: ReadonlySet<string>, elsewhere: ReadonlySet<string> = new Set()): Set<string> {
  const found = new Set<string>();
  const scan = (region: string) => {
    for (const match of region.matchAll(/[\w$]+/g)) {
      const name = match[0];
      if (!known.has(name) || elsewhere.has(name)) continue;
      const before = region.slice(0, match.index);
      const after = region[match.index + name.length];
      if (/[./$\-{]$/.test(before)) continue; // a member, a path, a template placeholder, a word of a dashed name
      if ((after !== undefined && '(<.'.includes(after)) || /(?:\b(?:new|extends|implements)\s+|<)$/.test(before)) found.add(name);
    }
  };
  // Inline code is a use when it is the name or starts like one: `Name`, `Name(`, `Name<`, `Name.`, `<Name`, `new Name`.
  const scanInline = (code: string) => {
    const start = /^(new\s+|<)?([\w$]+)/.exec(code);
    if (!start || !known.has(start[2]!) || elsewhere.has(start[2]!)) return;
    const after = code[start[0].length];
    if (start[1] !== undefined || after === undefined || '(<.`'.includes(after)) found.add(start[2]!);
  };
  const prose = text.replace(/```(?:tsx?|typescript)[^\n]*\n([\s\S]*?)```/g, (_, code: string) => {
    scan(code);
    return '';
  });
  // Code spans as CommonMark pairs them: a run of backticks closes with a run of the same length.
  for (const span of prose.matchAll(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g)) {
    const code = span[2]!.trim();
    if (!code.includes('/') && !/\.[a-z]{2,4}$/.test(code)) scanInline(code); // a path or a file name is no identifier
  }
  return found;
}

type Groups = Pick<NameUsage, 'mentioned' | 'docs' | 'apps' | 'kit' | 'siblings' | 'launchers' | 'tests' | 'reexportedBy' | 'namedBy' | 'namedHere'>;

function suggest(name: string, usage: Groups, wholeImports: readonly string[], testingEntry: boolean, alsoIn: readonly string[]): Pick<NameUsage, 'suggestion' | 'reason'> {
  let result = decide(name, usage, testingEntry);
  if (usage.namedBy.length > 0 && result.suggestion !== 'keep') {
    const entries = [...new Set(usage.namedBy.map((by) => by.split(' ')[0]!))];
    result = { suggestion: 'keep', reason: `named by a public declaration of ${entries.join(', ')}` };
  }
  if (usage.namedHere.length > 0 && result.suggestion !== 'keep') {
    result = { ...result, reason: `${result.reason}; named by ${usage.namedHere.slice(0, 3).join(', ')}${usage.namedHere.length > 3 ? ' …' : ''} — would show as Referenced` };
  }
  if (result.reason.startsWith('docs name it') && alsoIn.length > 0) result = { ...result, reason: `${result.reason}; also exported by ${alsoIn.join(', ')} — check which one the docs mean` };
  if (wholeImports.length === 0 || (result.suggestion !== 'drop' && result.suggestion !== 'internal')) return result;
  return { ...result, reason: `${result.reason}; entry imported as a whole by ${wholeImports.join(', ')} — check \`ns.Name\` uses` };
}

function decide(name: string, usage: Groups, testingEntry: boolean): Pick<NameUsage, 'suggestion' | 'reason'> {
  const appTests = usage.tests.filter((path) => !path.startsWith('packages/') || SHIPPED.test(path));
  const siblings = Object.keys(usage.siblings).sort();
  // `@marmeon/testing` is the kit's own test code: a double that only tests, docs and it use is a test double.
  if (!testingEntry && TEST_DOUBLE.test(name) && usage.apps.length === 0 && usage.kit.length === 0 && siblings.every((directory) => directory === 'testing')
    && (usage.tests.length > 0 || siblings.length > 0 || usage.docs.length > 0 || usage.mentioned.length > 0)) {
    return { suggestion: 'testing', reason: 'a test double that only tests, docs and @marmeon/testing use' };
  }
  if (usage.mentioned.length > 0 && usage.docs.length === 0 && usage.apps.length === 0 && usage.kit.length === 0) return { suggestion: 'keep', reason: 'docs name it without an import — check the entry' };
  if (usage.docs.length > 0 || usage.apps.length > 0 || usage.kit.length > 0) return { suggestion: 'keep', reason: 'docs, an app or the kit use it' };
  if (Object.keys(usage.launchers).length > 0) return { suggestion: 'keep', reason: "a package's launcher imports it; launchers may not import an internal subpath (check:source)" };
  if (usage.reexportedBy.length > 0) return { suggestion: 'keep', reason: 're-exported by another public entry' };
  if (siblings.length > 0) return { suggestion: 'internal', reason: `only ${siblings.join(', ')} use it` };
  if (appTests.length > 0) return { suggestion: 'keep', reason: 'only app tests use it — a test helper (testing) or part of the API?' };
  if (usage.tests.length > 0) return { suggestion: 'internal', reason: 'only tests of other packages use it' };
  return { suggestion: 'drop', reason: 'nobody outside the package uses it' };
}

/** The names a re-exporting statement of another package takes from `entry`: `export { X as Y } from '<entry>'` is X. */
function reexportedNames(item: ApiItem, entry: string): string[] {
  const names: string[] = [];
  for (const statement of item.text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (statement[3] === entry) names.push(...statement[1]!.split(',').map(importedName).filter((name) => name !== ''));
  }
  return names;
}

interface PackageSnapshot {
  readonly directory: string;
  readonly items: ApiItem[];
}

function readPackages(repository: string): PackageSnapshot[] {
  const packages: PackageSnapshot[] = [];
  const directory = join(repository, 'packages');
  if (!existsSync(directory)) return packages;
  for (const folder of readdirSync(directory).sort()) {
    const snapshot = join(directory, folder, 'api.md');
    if (existsSync(snapshot)) packages.push({ directory: folder, items: parseSnapshot(readFileSync(snapshot, 'utf8')) });
  }
  return packages;
}

/** The sections whose declarations an app sees: an item of these names the types it uses. */
const PUBLIC_SECTIONS: ReadonlySet<ApiItem['section']> = new Set(['stable', 'referenced', 'augments', 'experimental']);

/**
 * The identifiers in a declaration's text that can be references: no members (`a.Name`), parts of longer words (`PageObjectLike`),
 * words in string literals or `//` lines, and no property, parameter or method name (a word followed by `:`, `?:`, `(` or `?(`;
 * in printed declarations a reference never is). The code in `${…}` of a template literal type counts. A qualified
 * `import("<entry>").Name` names `Name`.
 */
function identifiersOf(text: string, entry: string): Set<string> {
  const code = withoutStrings(text.replace(/^\s*\/\/.*$/gm, ''));
  const words = new Set([...code.matchAll(/(?<![\w$.])[\w$]+(?![\w$])(?!\??[:(])/g)].map((match) => match[0]));
  for (const match of text.matchAll(/\bimport\(\s*(["'])([^"'\n]+)\1\s*\)\.([\w$]+)/g)) if (match[2] === entry) words.add(match[3]!);
  return words;
}

/** The text with every string literal reduced to `""`; the placeholders of a template literal stay, as code. */
function withoutStrings(text: string): string {
  let at = 0;
  const code = (insidePlaceholder: boolean): string => {
    let out = '';
    let depth = 0;
    while (at < text.length) {
      const char = text[at]!;
      if (char === '"' || char === "'" || char === '`') {
        at += 1;
        out += `""${literal(char)}`;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        if (insidePlaceholder && depth === 0) return out;
        depth -= 1;
      }
      out += char;
      at += 1;
    }
    return out;
  };
  /** Skips to the closing quote; returns the code of the placeholders in between. */
  const literal = (quote: string): string => {
    let placeholders = '';
    while (at < text.length) {
      const char = text[at]!;
      if (char === '\\') at += 2;
      else if (char === quote) {
        at += 1;
        break;
      } else if (quote === '`' && char === '$' && text[at + 1] === '{') {
        at += 2;
        placeholders += ` ${code(true)} `;
        at += 1;
      } else at += 1;
    }
    return placeholders;
  };
  return code(false);
}

const isExport = (item: ApiItem) => item.section === 'stable' || item.section === 'experimental';

/** The entry points that have a snapshot: what `api:usage` accepts. */
export function knownEntries(repository: string = root): string[] {
  return [...new Set(readPackages(repository).flatMap((pkg) => pkg.items.map((item) => item.entry).filter((entry) => entry !== '')))].sort();
}

/**
 * Who imports each export of `entry`, or `undefined` when no snapshot lists it. A name used only inside its own package (sources
 * and tests) counts as unused; the package's `stubs/` and README are what an app copies and reads, so they count.
 */
export function usageOf(entry: string, repository: string = root, files: readonly SourceFile[] = repositoryFiles(repository)): EntryUsage | undefined {
  const packages = readPackages(repository);
  const own = packages.find((pkg) => pkg.items.some((item) => item.entry === entry));
  if (!own) return undefined;
  const names = [...new Set(own.items.filter((item) => item.entry === entry && isExport(item)).map((item) => item.name))].sort();
  const known = new Set(names);

  const importers = new Map<string, Set<string>>();
  const wholeImports = new Set<string>();
  const mentions = new Map<string, Set<string>>();
  for (const { path, text } of files) {
    if (!CODE_FILE.test(path) || !classify(path, own.directory)) continue;
    if (classify(path, own.directory)!.kind === 'docs') {
      const elsewhere = new Set(importsOf(text).filter((statement) => statement.specifier !== entry).flatMap((statement) => statement.names ?? []));
      for (const name of mentionsOf(text, known, elsewhere)) mentions.set(name, (mentions.get(name) ?? new Set()).add(path));
    }
    if (!text.includes(entry)) continue;
    for (const statement of importsOf(text)) {
      if (statement.specifier !== entry) continue;
      if (statement.names === undefined && statement.namespace !== undefined) {
        const use = namespaceUseOf(text, statement.namespace);
        if (use.whole) wholeImports.add(path);
        for (const name of use.names) if (known.has(name)) importers.set(name, (importers.get(name) ?? new Set()).add(path));
      } else if (statement.names === undefined) wholeImports.add(path);
      else for (const name of statement.names) if (known.has(name)) importers.set(name, (importers.get(name) ?? new Set()).add(path));
    }
  }

  const reexports = new Map<string, Set<string>>();
  for (const pkg of packages) {
    if (pkg === own) continue;
    for (const item of pkg.items.filter(isExport)) {
      for (const name of reexportedNames(item, entry)) reexports.set(name, (reexports.get(name) ?? new Set()).add(item.entry));
    }
  }

  const whole = [...wholeImports].sort();
  const testingEntry = own.directory === 'testing' || entry.endsWith('/testing');
  const exportedBy = new Map<string, Set<string>>();
  for (const pkg of packages) {
    for (const item of pkg.items.filter(isExport)) if (item.entry !== entry && known.has(item.name)) exportedBy.set(item.name, (exportedBy.get(item.name) ?? new Set()).add(item.entry));
  }
  // Which declarations name which of the entry's names: in another entry they keep the name public, in this one they are a hint.
  const namedBy = new Map<string, Set<string>>();
  const namedHere = new Map<string, Set<string>>();
  for (const pkg of packages) {
    for (const item of pkg.items) {
      if (!PUBLIC_SECTIONS.has(item.section) || item.entry === '') continue;
      for (const word of identifiersOf(item.text, entry)) {
        if (!known.has(word) || word === item.name) continue;
        const target = item.entry === entry ? namedHere : namedBy;
        target.set(word, (target.get(word) ?? new Set()).add(item.entry === entry ? item.name : `${item.entry} ${item.name}`));
      }
    }
  }
  const result = names.map((name): NameUsage => {
    const usage: Groups = {
      mentioned: [...(mentions.get(name) ?? [])].sort(), docs: [], apps: [], kit: [], siblings: {}, launchers: {}, tests: [], reexportedBy: [...(reexports.get(name) ?? [])].sort(),
      namedBy: [...(namedBy.get(name) ?? [])].sort(), namedHere: [...(namedHere.get(name) ?? [])].sort(),
    };
    for (const path of [...(importers.get(name) ?? [])].sort()) {
      const kind = classify(path, own.directory)!;
      if (kind.kind === 'sibling') (usage.siblings[kind.directory] ??= []).push(path);
      else if (kind.kind === 'launcher') (usage.launchers[kind.directory] ??= []).push(path);
      else if (kind.kind === 'docs') usage.docs.push(path);
      else if (kind.kind === 'apps') usage.apps.push(path);
      else if (kind.kind === 'kit') usage.kit.push(path);
      else usage.tests.push(path);
    }
    return { name, ...suggest(name, usage, whole, testingEntry, [...(exportedBy.get(name) ?? [])].sort()), ...usage };
  });
  return { entry, names: result, wholeImports: whole };
}

const ORDER: readonly Suggestion[] = ['keep', 'testing', 'internal', 'drop'];

/** The report as text: a section per suggestion, a line per name with the number of importing files per group. */
export function renderUsage(usage: EntryUsage, withFiles = false): string {
  const count = (suggestion: Suggestion) => usage.names.filter((name) => name.suggestion === suggestion).length;
  const lines = [
    `${usage.entry}: ${usage.names.length} names (${ORDER.map((suggestion) => `${count(suggestion)} ${suggestion}`).join(', ')})`,
    'The suggestions are a first guess: check yourself whether apps or drivers implement a name.',
  ];
  for (const suggestion of ORDER) {
    const names = usage.names.filter((name) => name.suggestion === suggestion);
    if (names.length === 0) continue;
    lines.push('', `${suggestion} (${names.length})`);
    for (const name of names) {
      const parts: string[] = [];
      if (name.docs.length > 0) parts.push(`docs ${name.docs.length}`);
      if (name.mentioned.length > 0) parts.push(`mentioned in ${name.mentioned.length} docs`);
      if (name.apps.length > 0) parts.push(`apps ${name.apps.length}`);
      if (name.kit.length > 0) parts.push(`kit ${name.kit.length}`);
      for (const [directory, list] of Object.entries(name.siblings)) parts.push(`${directory} ${list.length}`);
      for (const [directory, list] of Object.entries(name.launchers)) parts.push(`${directory} launcher ${list.length}`);
      if (name.tests.length > 0) parts.push(`tests ${name.tests.length}`);
      if (name.reexportedBy.length > 0) parts.push(`re-exported by ${name.reexportedBy.join(', ')}`);
      if (name.namedBy.length > 0) parts.push(`named by ${name.namedBy.join(', ')}`);
      if (name.namedHere.length > 0) parts.push(`named here by ${name.namedHere.join(', ')} — would show as Referenced`);
      lines.push(`  ${name.name}${parts.length > 0 ? `  — ${parts.join(' · ')}` : ''}`);
      if (withFiles) for (const path of [...name.docs, ...name.mentioned, ...name.apps, ...name.kit, ...Object.values(name.siblings).flat(), ...Object.values(name.launchers).flat(), ...name.tests]) lines.push(`      ${path}`);
    }
  }
  if (usage.wholeImports.length > 0) lines.push('', `Imported as a whole (the names they use are not known): ${usage.wholeImports.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

export function main(argv: readonly string[]): number {
  const options = { json: { type: 'boolean' }, files: { type: 'boolean' } } as const;
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true });
  } catch (error) {
    console.error(`api:usage: ${(error as Error).message}`);
    return 2;
  }
  const entry = parsed.positionals[0];
  if (entry === undefined || parsed.positionals.length > 1) {
    console.error('usage: pnpm api:usage <entry> [--files] [--json]   e.g. pnpm api:usage @marmeon/core');
    return 2;
  }
  const usage = usageOf(entry);
  if (!usage) {
    console.error(`api:usage: no api.md lists ${entry} — the entry points are:\n  ${knownEntries().join('\n  ')}`);
    return 1;
  }
  console.log(parsed.values.json ? JSON.stringify(usage, null, 2) : renderUsage(usage, parsed.values.files));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
