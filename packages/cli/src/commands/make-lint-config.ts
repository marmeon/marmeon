import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import type { CommandInput } from '../command.ts';
import { style } from '../output.ts';
import { leavesProject, refusesOverwrite } from '../write-guard.ts';
import { declaredServerModules, SERVER_MODULES, writeProjectFile } from '@marmeon/core/internal';

/** The file oxlint reads in the app root. */
export const LINT_CONFIG_FILE = '.oxlintrc.json';

/** Client code: what reaches the browser (pages, layouts, the client entry). */
const CLIENT_FILES = ['modules/*/views/**', 'modules/*/layouts/**', 'layouts/**', 'bootstrap/client.*'];
const TEST_FILES = ['**/*.test.*', '**/*.type-test.*'];
/** Folder depths inside a module the boundary rule covers at least (`modules/<name>/a/b/…/file.ts`). */
const MIN_DEPTH = 8;

const CLIENT_MESSAGE =
  'Client code (views, layouts, the client entry) imports server code — the conventions of marmeon() (controllers, jobs, mail, config, a module\'s entry …) and the folders of package.json\'s "marmeon"."serverModules" — only with `import type`: a value import bundles it, and everything it imports, into the browser.';
const BOUNDARY_MESSAGE =
  "Modules import other modules only through their entry — import { … } from '#modules/<name>' — never a file inside them (marmeon make:lint-config --boundaries).";

export const INTERNAL_MESSAGE =
  "`@marmeon/*/internal` is the framework's own code, not API — it can change in any release. Use the package's entry; if you need something only an internal subpath has, open an issue.";

type Pattern = { group?: string[]; regex?: string; allowTypeImports?: boolean; message: string };
type Override = { files: string[]; rules: Record<string, unknown> };

/** What oxlint can tell from the specifier's text beyond the folder globs: repositories, providers and module entries by name. */
const CLIENT_REGEX_PATTERNS: Pattern[] = [
  { regex: '(?:Repository|ServiceProvider)(?:\\.[cm]?[jt]sx?)?$', allowTypeImports: true, message: CLIENT_MESSAGE },
  { regex: '^#modules/', allowTypeImports: true, message: CLIENT_MESSAGE },
];

/** The conventions `CLIENT_REGEX_PATTERNS` match by name. */
const BY_REGEX = new Set(['**/*ServiceProvider.ts', '**/*Repository.ts']);

/** The group every client file gets, whatever its depth: controllers, wherever they are. */
const CONTROLLERS: Pattern = { group: ['**/controllers/**'], allowTypeImports: true, message: CLIENT_MESSAGE };

/** Client code may import these as types only — the fallback for files deeper than the per-depth overrides cover. */
const CLIENT_PATTERNS: Pattern[] = [CONTROLLERS, ...CLIENT_REGEX_PATTERNS];

/** No file of the app — tests included — imports a package's `./internal` subpath. */
const INTERNAL_PATTERN: Pattern = { regex: '^@marmeon/[^/]+/internal(?:/|$)', message: INTERNAL_MESSAGE };

/**
 * From a file `depth` folders below its module (`modules/<name>/` is depth 0), `../` × (depth + 1) reaches `modules/`: the
 * next segment is another module, and anything but its `index` is inside it — also the way round over the app root
 * (`../modules/<name>/…`). Gitignore patterns, not a regex: oxlint's regexes have no lookaround (and an invalid one is dropped
 * without a word), so "but not index" is a negation here.
 */
function boundaryPattern(depth: number): Pattern {
  const up = '../'.repeat(depth + 1);
  return { group: [`${up}*/**`, `!${up}*/index.*`, `!${up}../**`, `${up}../modules/*/**`, `!${up}../modules/*/index.*`], message: BOUNDARY_MESSAGE };
}

const restrict = (patterns: Pattern[]) => ({ 'no-restricted-imports': ['error', { patterns }] });
const levels = (depth: number) => '*/'.repeat(depth);

/**
 * The specifiers (gitignore globs, as oxlint matches them) with which a file in `dir` reaches a file `glob` matches. File
 * globs are relative to the app root, specifiers to the importing file, so the glob is cut at every segment `dir` shares with
 * it: `dir` holds the folders from the root (`*` for any folder), and the result has one pattern per way up (`../../…`).
 * A glob that starts with `**` matches at any depth, `..` segments included.
 */
export function specifierPatterns(dir: readonly string[], glob: string): string[] {
  const segments = glob.split('/');
  if (segments[0] === '**') return [glob];
  const patterns: string[] = [];
  for (let k = 0; k <= Math.min(dir.length, segments.length - 1); k++) {
    if (k > 0) {
      const i = k - 1;
      const segment = segments[i] as string;
      const folder = dir[i] as string;
      if (segment === '**' || !(segment === '*' || (folder !== '*' && matchesGlob(folder, segment)))) break;
    }
    patterns.push((dir.length - k === 0 ? './' : '../'.repeat(dir.length - k)) + segments.slice(k).join('/'));
  }
  return patterns;
}

const EXTENSION = '(?:\\.[cm]?[jt]sx?)?';

/**
 * A server glob as a regex over the specifier's text, for the patterns a gitignore group cannot carry: the boundary rule's
 * `!` patterns apply to every pattern of the rule, and they take back the specifiers that climb to the app root. The grammar
 * of a declared glob is narrow (literal segments, `*`, `**`, an extension), so the translation is small. A file extension at
 * the end is optional, as the specifier may leave it out. No lookaround: oxlint drops a regex it cannot compile, without a word.
 */
function globRegex(glob: string): string {
  const segments = glob.split('/');
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') return last ? '.*' : '(?:[^/]+/)*';
      const extension = last ? /\.[cm]?[jt]sx?$/.exec(segment) : null;
      const text = extension ? segment.slice(0, -extension[0].length) : segment;
      return `${escape(text)}${extension ? EXTENSION : ''}${last ? '' : '/'}`;
    })
    .join('');
}

/** A module name: the segment after `modules/` in a declared glob, when it names one module (no glob characters). */
function namedModule(glob: string): string | undefined {
  const [first, name, ...rest] = glob.replace(/^!/, '').split('/');
  return first === 'modules' && name !== undefined && rest.length > 0 && !/[*?[\]{}()!]/.test(name) ? name : undefined;
}

/**
 * The oxlint config `marmeon make:lint-config` writes. Client files may import server modules — the conventions of
 * `SERVER_MODULES` and the folders `serverModules` declares (package.json) — and controllers, repositories, providers and
 * module entries as types only (`no-restricted-imports` with `allowTypeImports`), and `import { type X }` must be
 * `import type { X }` — it would load the module otherwise (`verbatimModuleSyntax`). `boundaries` (opt-in):
 * a module imports another one only through its entry. oxlint matches specifiers as text, and a later override replaces an
 * earlier one's options for the same rule — so there is one override per folder depth (a file glob is relative to the app
 * root, a specifier to the importing file), and client files get the boundary rule in theirs. No file, tests included, imports
 * `@marmeon/<package>/internal`: that pattern is in every list, and tests get it alone.
 */
export function lintConfig({
  boundaries = false,
  depth = MIN_DEPTH,
  serverModules = [],
}: { boundaries?: boolean; depth?: number; serverModules?: readonly string[] } = {}): Record<string, unknown> {
  const overrides: Override[] = [];
  // Repositories and service providers are in the regex entries already: a second hit would report an import twice.
  const positive = [...SERVER_MODULES.map((module) => module.pattern).filter((glob) => !BY_REGEX.has(glob)), ...serverModules.filter((glob) => !glob.startsWith('!'))];
  const negative = serverModules.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1));
  /** The rules of client files in `dir`: the server modules as specifier patterns, the regexes and the internals. */
  const clientRules = (dir: readonly string[], boundaryLevel?: number) => {
    // oxlint lets a `!` pattern of a group that matches a specifier end the check for it, for the groups and the regexes that
    // follow, and the boundary rule's `!` patterns match every specifier that climbs to the app root. What is not in `modules/` is
    // reached that way (config/, bootstrap/app.ts, a declared `domain/**`), so there it is a regex, and the regexes come first.
    const rooted = (glob: string) => boundaryLevel !== undefined && !glob.startsWith('modules/');
    const group = [
      ...new Set([
        ...(CONTROLLERS.group as string[]),
        ...positive.filter((glob) => !rooted(glob)).flatMap((glob) => specifierPatterns(dir, glob)),
        // With the boundary rule, a `!` that leaves the module would also end that rule's check for the specifier: a negation keeps
        // to the forms that stay inside the module, and an import across modules is a boundary error anyway.
        ...negative.flatMap((glob) =>
          specifierPatterns(dir, glob)
            .filter((pattern) => boundaryLevel === undefined || !pattern.startsWith('../'.repeat(boundaryLevel + 1)))
            .map((pattern) => `!${pattern}`),
        ),
      ]),
    ];
    const server: Pattern = { group, allowTypeImports: true, message: CLIENT_MESSAGE };
    const above = positive.filter(rooted);
    const climbing = above.filter((glob) => !glob.startsWith('**/')).map(globRegex);
    const anywhere = above.filter((glob) => glob.startsWith('**/')).map(globRegex);
    const regexes: Pattern[] = [
      ...(climbing.length > 0 ? [{ regex: `^(?:\\.\\./){${dir.length}}(?:${climbing.join('|')})$`, allowTypeImports: true, message: CLIENT_MESSAGE }] : []),
      ...(anywhere.length > 0 ? [{ regex: `^(?:${anywhere.join('|')})$`, allowTypeImports: true, message: CLIENT_MESSAGE }] : []),
    ];
    return restrict([...regexes, ...CLIENT_REGEX_PATTERNS, INTERNAL_PATTERN, ...(boundaryLevel === undefined ? [] : [boundaryPattern(boundaryLevel)]), server]);
  };

  if (boundaries) {
    for (let level = 0; level < depth; level++) overrides.push({ files: [`modules/*/${levels(level)}*`], rules: restrict([boundaryPattern(level), INTERNAL_PATTERN]) });
  }
  // Files deeper than the overrides below cover keep the protection of the controllers and the regexes.
  overrides.push({ files: CLIENT_FILES, rules: restrict([...CLIENT_PATTERNS, INTERNAL_PATTERN]) });
  // Client files inside a module (views/ and layouts/): generic for every module, then one per module a declared glob names —
  // only there is a folder of the same module known.
  const named = [...new Set(serverModules.map(namedModule).filter((name): name is string => name !== undefined))];
  for (const module of ['*', ...named]) {
    for (let level = 0; level < depth - 1; level++) {
      overrides.push({
        files: [`modules/${module}/views/${levels(level)}*`, `modules/${module}/layouts/${levels(level)}*`],
        rules: clientRules(['modules', module, '*', ...Array<string>(level).fill('*')], boundaries ? level + 1 : undefined),
      });
    }
  }
  // The app's own layouts and the client entry.
  for (let level = 0; level < depth; level++) overrides.push({ files: [`layouts/${levels(level)}*`], rules: clientRules(['layouts', ...Array<string>(level).fill('*')]) });
  overrides.push({ files: ['bootstrap/client.*'], rules: clientRules(['bootstrap']) });
  // Tests run on the server, never in the browser: they reach into any module (factories, jobs, controllers' types), but not
  // into the framework's internals.
  overrides.push({ files: TEST_FILES, rules: restrict([INTERNAL_PATTERN]) });
  // oxlint reports nothing from node_modules or dist then, even without a .gitignore. (It still walks them: only a .gitignore —
  // which every app has — or --ignore-pattern keeps it out; through pnpm's links that walk takes half a minute.)
  // `no-unused-private-class-members` is off for every class, not only for events: `readonly #event = true` (make:event) makes an
  // event a type of its own and is never read, and the rule cannot tell that field from another.
  return {
    ignorePatterns: ['node_modules/**', 'dist/**'],
    rules: { 'typescript/no-import-type-side-effects': 'error', 'no-unused-private-class-members': 'off', ...restrict([INTERNAL_PATTERN]) },
    overrides,
  };
}

/** A short hash of what a preset was written for: the conventions of `SERVER_MODULES` and the declared server folders. */
export function serverModulesFingerprint(declared: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([SERVER_MODULES.map((module) => module.pattern), declared]))
    .digest('hex')
    .slice(0, 16);
}

/** How many folders deep the app's modules go (`modules/<name>/a/b/file.ts` = 2). */
function deepestModuleFolder(root: string): number {
  const modules = join(root, 'modules');
  if (!existsSync(modules)) return 0;
  let deepest = 0;
  for (const entry of readdirSync(modules, { recursive: true, withFileTypes: true, encoding: 'utf8' })) {
    if (!entry.isFile() || /(^|[/\\])node_modules([/\\]|$)/.test(entry.parentPath)) continue;
    const below = entry.parentPath.slice(modules.length).split(/[/\\]/).filter(Boolean);
    deepest = Math.max(deepest, below.length - 1);
  }
  return deepest;
}

export class MakeLintConfigCommand {
  static command = 'make:lint-config';
  static description = 'Create .oxlintrc.json: client code imports server code (the conventions, package.json serverModules) as types only (--boundaries: modules through their entry), no @marmeon/*/internal';
  static usage = '[--boundaries] [--force]';
  static options = { boundaries: { type: 'boolean' }, force: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const file = join(root, LINT_CONFIG_FILE);
    if (leavesProject({ root, output }, [file])) return 1;
    if (options.force === true && refusesOverwrite({ root, output }, [file])) return 1;
    if (existsSync(file) && options.force !== true) {
      output.error(`${LINT_CONFIG_FILE} already exists (use --force to overwrite).`);
      return 1;
    }
    let declared: readonly string[];
    try {
      declared = declaredServerModules(root);
    } catch (error) {
      output.error((error as Error).message);
      return 1;
    }
    const boundaries = options.boundaries === true;
    const config = lintConfig({ boundaries, depth: Math.max(MIN_DEPTH, deepestModuleFolder(root) + 2), serverModules: declared });
    const header = [
      `// Generated by \`marmeon make:lint-config${boundaries ? ' --boundaries' : ''}\` — yours to change; --force writes it anew.`,
      `// marmeon:server-modules ${serverModulesFingerprint(declared)} — written for the conventions of marmeon() and package.json's "marmeon"."serverModules"; marmeon check warns when they change.`,
      '// Client code (views, layouts, the client entry) imports server code (the conventions of marmeon() and the folders package.json',
      '// declares) only with `import type`: a value import bundles it into the browser. The marmeon() Vite plugin refuses that too',
      '// (resolved paths, also indirect imports); this catches it in the editor.',
      "// No file imports @marmeon/<package>/internal — the framework's own code, not API; tests included.",
      '// Unused private class members are no warning, in any class: `readonly #event = true` (make:event) makes an event a type of its own and is never read.',
      ...(boundaries
        ? [
            "// --boundaries (opt-in): a module imports another module only through its entry (#modules/<name>). oxlint matches the",
            '// import as text, so there is one override per folder depth; tests may reach into any module.',
          ]
        : []),
    ];
    writeProjectFile(file, `${header.join('\n')}\n${formatConfig(config)}\n`);
    output.success(`Created ${LINT_CONFIG_FILE}`);
    output.line();
    output.line('Lint with oxlint:');
    output.line(style('dim', '  pnpm add -D oxlint'));
    output.line(style('dim', '  pnpm exec oxlint'));
    if (boundaries && !hasModuleImports(root)) {
      output.line();
      output.line(`Modules import each other through ${style('bold', "'#modules/<name>'")} — map it in package.json:`);
      output.line(style('dim', '  "imports": { "#modules/*": "./modules/*/index.ts" }'));
    }
    return 0;
  }
}

/** JSON with one line per override and per import pattern — readable, and diffable when it is generated anew. */
export function formatConfig(config: Record<string, unknown>): string {
  const { overrides = [], ...rest } = config as { overrides?: Override[] };
  // `{ "a": 1 }` and `["x", "y"]` on one line.
  const inline = (value: unknown) => JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']');
  const rule = ([name, value]: [string, unknown]) => {
    const [level, options] = Array.isArray(value) ? value : [value];
    const patterns = (options as { patterns?: Pattern[] } | undefined)?.patterns;
    if (!patterns) return `${JSON.stringify(name)}: ${inline(value)}`;
    return `${JSON.stringify(name)}: [${JSON.stringify(level)}, { "patterns": [\n${patterns.map((pattern) => `        ${inline(pattern)}`).join(',\n')}\n      ] }]`;
  };
  const lines = overrides.map(({ files, rules }) => `    {\n      "files": ${inline(files)},\n      "rules": { ${Object.entries(rules).map(rule).join(', ')} }\n    }`);
  const head = Object.entries(rest).map(([key, value]) => `  ${JSON.stringify(key)}: ${inline(value)}`);
  return `{\n${[...head, `  "overrides": [\n${lines.join(',\n')}\n  ]`].join(',\n')}\n}`;
}

function hasModuleImports(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { imports?: Record<string, unknown> };
    return manifest.imports?.['#modules/*'] !== undefined;
  } catch {
    return false;
  }
}
