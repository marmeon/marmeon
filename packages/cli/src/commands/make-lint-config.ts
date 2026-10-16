import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandInput } from '../command.ts';
import { style } from '../output.ts';

/** The file oxlint reads in the app root. */
export const LINT_CONFIG_FILE = '.oxlintrc.json';

/** Client code: what reaches the browser (pages, layouts, the client entry). */
const CLIENT_FILES = ['modules/*/views/**', 'modules/*/layouts/**', 'layouts/**', 'bootstrap/client.*'];
const TEST_FILES = ['**/*.test.*', '**/*.type-test.*'];
/** Folder depths inside a module the boundary rule covers at least (`modules/<name>/a/b/…/file.ts`). */
const MIN_DEPTH = 8;

const CLIENT_MESSAGE =
  'Client code (views, layouts, the client entry) imports server code — controllers, repositories, service providers, a module\'s entry (#modules/…) — only with `import type`: a value import bundles it, and everything it imports, into the browser.';
const BOUNDARY_MESSAGE =
  "Modules import other modules only through their entry — import { … } from '#modules/<name>' — never a file inside them (marmeon make:lint-config --boundaries).";

const INTERNAL_MESSAGE =
  "`@marmeon/*/internal` is the framework's own code, not API — it can change in any release. Use the package's entry; if you need something only an internal subpath has, open an issue.";

type Pattern = { group?: string[]; regex?: string; allowTypeImports?: boolean; message: string };
type Override = { files: string[]; rules: Record<string, unknown> };

/** Client code may import these as types only — what oxlint can tell from the specifier's text (the Vite plugin resolves). */
const CLIENT_PATTERNS: Pattern[] = [
  { group: ['**/controllers/**'], allowTypeImports: true, message: CLIENT_MESSAGE },
  { regex: '(?:Repository|ServiceProvider)(?:\\.[cm]?[jt]sx?)?$', allowTypeImports: true, message: CLIENT_MESSAGE },
  { regex: '^#modules/', allowTypeImports: true, message: CLIENT_MESSAGE },
];

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
 * The oxlint config `marmeon make:lint-config` writes. Client files may import controllers, repositories, providers and
 * module entries as types only (`no-restricted-imports` with `allowTypeImports`), and `import { type X }` must be
 * `import type { X }` — it would load the module otherwise (`verbatimModuleSyntax`). `boundaries` (opt-in):
 * a module imports another one only through its entry. oxlint matches specifiers as text, and a later override replaces an
 * earlier one's options for the same rule — so the boundary rule has one override per folder depth, and client files get
 * both rules in theirs. No file, tests included, imports `@marmeon/<package>/internal`: that pattern is in every
 * list, and tests get it alone.
 */
export function lintConfig({ boundaries = false, depth = MIN_DEPTH }: { boundaries?: boolean; depth?: number } = {}): Record<string, unknown> {
  const overrides: Override[] = [];
  if (boundaries) {
    for (let level = 0; level < depth; level++) overrides.push({ files: [`modules/*/${levels(level)}*`], rules: restrict([boundaryPattern(level), INTERNAL_PATTERN]) });
    // Client files inside a module: both rules (views/ and layouts/ are depth 1).
    for (let level = 1; level < depth; level++) {
      overrides.push({
        files: [`modules/*/views/${levels(level - 1)}*`, `modules/*/layouts/${levels(level - 1)}*`],
        rules: restrict([boundaryPattern(level), ...CLIENT_PATTERNS, INTERNAL_PATTERN]),
      });
    }
    overrides.push({ files: CLIENT_FILES.filter((files) => !files.startsWith('modules/')), rules: restrict([...CLIENT_PATTERNS, INTERNAL_PATTERN]) });
    // Tests reach into any module (factories, jobs, controllers' types), but not into the framework's internals.
    overrides.push({ files: TEST_FILES, rules: restrict([INTERNAL_PATTERN]) });
  } else {
    overrides.push({ files: CLIENT_FILES, rules: restrict([...CLIENT_PATTERNS, INTERNAL_PATTERN]) });
  }
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
  static description = 'Create .oxlintrc.json: client code imports server code as types only (--boundaries: modules through their entry), no @marmeon/*/internal';
  static usage = '[--boundaries] [--force]';
  static options = { boundaries: { type: 'boolean' }, force: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const file = join(root, LINT_CONFIG_FILE);
    if (existsSync(file) && options.force !== true) {
      output.error(`${LINT_CONFIG_FILE} already exists (use --force to overwrite).`);
      return 1;
    }
    const boundaries = options.boundaries === true;
    const config = lintConfig({ boundaries, depth: Math.max(MIN_DEPTH, deepestModuleFolder(root) + 2) });
    const header = [
      `// Generated by \`marmeon make:lint-config${boundaries ? ' --boundaries' : ''}\` — yours to change; --force writes it anew.`,
      '// Client code (views, layouts, the client entry) imports controllers, repositories, providers and module entries only with',
      '// `import type`: a value import bundles server code into the browser. The marmeon() Vite plugin refuses that too (resolved',
      '// paths, also indirect imports); this catches it in the editor.',
      "// No file imports @marmeon/<package>/internal — the framework's own code, not API; tests included.",
      '// Unused private class members are no warning, in any class: `readonly #event = true` (make:event) makes an event a type of its own and is never read.',
      ...(boundaries
        ? [
            "// --boundaries (opt-in): a module imports another module only through its entry (#modules/<name>). oxlint matches the",
            '// import as text, so there is one override per folder depth; tests may reach into any module.',
          ]
        : []),
    ];
    writeFileSync(file, `${header.join('\n')}\n${formatConfig(config)}\n`);
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
