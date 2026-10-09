import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINT_CONFIG_FILE, lintConfig, MakeLintConfigCommand } from './commands/make-lint-config.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const oxlint = join(repo, 'node_modules/.bin/oxlint');

const CONTROLLER = 'export class ShowLoginController {}\n';

/** An app's files: a controller, a repository, a module entry — and the imports under test. */
function app(files: Record<string, string>): string {
  const root = realpathSync(tempDir('marmeon-lint-'));
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', imports: { '#modules/*': './modules/*/index.ts' } }),
    'config/app.ts': 'export const AppConfig = {};\n',
    'modules/auth/index.ts': "export { UserRepository } from './UserRepository.ts';\n",
    'modules/auth/UserRepository.ts': 'export class UserRepository {}\n',
    'modules/auth/controllers/ShowLoginController.ts': CONTROLLER,
    'modules/auth/notifications/NewSignIn.ts': 'export class NewSignIn {}\n',
    'modules/billing/index.ts': "export { Invoices } from './Invoices.ts';\n",
    'modules/billing/Invoices.ts': 'export class Invoices {}\n',
    'modules/billing/deep/er/Totals.ts': 'export const totals = 1;\n',
    'modules/notifications/index.ts': 'export const bell = 1;\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function generate(root: string, options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), line: (line = '') => lines.push(line) };
  const code = new MakeLintConfigCommand().handle({ root, args: [], options, output, spawn: async () => 0 } as never);
  return { code, lines };
}

/** `file:line rule` for every error oxlint reports (warnings of its default rules aside). */
function lint(root: string): string[] {
  const result = spawnSync(oxlint, ['-f', 'unix', '.'], { cwd: root, encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .filter((line) => line.includes('[Error/'))
    .map((line) => line.replace(/^(.+?):(\d+):\d+: .*\[Error\/(.+)\]$/, '$1:$2 $3'))
    .sort();
}

const CLIENT = {
  // A class is a value: this ships the controller.
  'modules/auth/views/Login.tsx': "import { ShowLoginController } from '../controllers/ShowLoginController.ts';\nexport type P = ShowLoginController;\n",
  'modules/auth/views/Typed.tsx': "import type { ShowLoginController } from '../controllers/ShowLoginController.ts';\nexport type { ShowLoginController as C } from '../controllers/ShowLoginController.ts';\nexport type P = ShowLoginController;\n",
  // `import { type X }` stays as `import {} from …` (verbatimModuleSyntax): it loads the module.
  'modules/auth/views/Inline.tsx': "import { type ShowLoginController } from '../controllers/ShowLoginController.ts';\nexport type P = ShowLoginController;\n",
  'modules/auth/views/settings/Tokens.tsx': "import { UserRepository } from '../../UserRepository.ts';\nimport type { Invoices } from '#modules/billing';\nexport const r = UserRepository;\nexport type I = Invoices;\n",
  'modules/auth/layouts/Settings.tsx': "import { Invoices } from '#modules/billing';\nexport const i = Invoices;\n",
  'layouts/AppLayout.tsx': "import { ShowLoginController } from '../modules/auth/controllers/ShowLoginController.ts';\nexport const c = ShowLoginController;\n",
};

const MODULES = {
  // Into another module: depth 0, 1 and 3, and the way round over the app root.
  'modules/auth/sessions.ts': "import { Invoices } from '../billing/Invoices.ts';\nimport { totals } from '../../modules/billing/deep/er/Totals.ts';\nexport const x = [Invoices, totals];\n",
  'modules/auth/listeners/SendWelcome.ts': "import { Invoices } from '../../billing/Invoices.ts';\nimport { NewSignIn } from '../notifications/NewSignIn.ts';\nexport const x = [Invoices, NewSignIn];\n",
  'modules/auth/a/b/c/Deep.ts': "import { totals } from '../../../../billing/deep/er/Totals.ts';\nexport const x = totals;\n",
  // Through the entry, within the module, and up to the app: fine.
  'modules/auth/listeners/Fine.ts':
    "import { Invoices } from '#modules/billing';\nimport { bell } from '../../notifications/index.ts';\nimport { AppConfig } from '../../../config/app.ts';\nimport { UserRepository } from '../UserRepository.ts';\nexport const x = [Invoices, bell, AppConfig, UserRepository];\n",
  // Tests reach into any module.
  'modules/auth/auth.test.ts': "import { totals } from '../billing/deep/er/Totals.ts';\nexport const x = totals;\n",
};

describe('marmeon make:lint-config', () => {
  it('writes .oxlintrc.json once (--force writes it anew), and says how to run oxlint', () => {
    const root = app({});
    const first = generate(root);
    expect(first.code).toBe(0);
    expect(first.lines).toEqual(['✓ Created .oxlintrc.json', '', 'Lint with oxlint:', expect.stringContaining('pnpm add -D oxlint'), expect.stringContaining('pnpm exec oxlint')]);
    expect(readFileSync(join(root, LINT_CONFIG_FILE), 'utf8')).toMatch(/^\/\/ Generated by `marmeon make:lint-config` — yours to change/);
    expect(generate(root)).toEqual({ code: 1, lines: ['✗ .oxlintrc.json already exists (use --force to overwrite).'] });
    expect(generate(root, { force: true, boundaries: true }).code).toBe(0);
    expect(readFileSync(join(root, LINT_CONFIG_FILE), 'utf8')).toContain('--boundaries');
  });

  it('asks for the #modules/* mapping with --boundaries when package.json lacks it', () => {
    const root = app({ 'package.json': JSON.stringify({ name: 'fixture', type: 'module' }) });
    expect(generate(root, { boundaries: true }).lines.join('\n')).toContain('"imports": { "#modules/*": "./modules/*/index.ts" }');
    expect(generate(app({}), { boundaries: true }).lines.join('\n')).not.toContain('"imports"');
  });

  it('client code imports server code as types only — oxlint fails value imports and `import { type X }`', () => {
    // node_modules is left alone even without a .gitignore (a fresh app): oxlint would walk pnpm's links without end.
    const root = app({ ...CLIENT, ...MODULES, 'node_modules/some-package/index.ts': "import { type A } from './a.ts';\nexport type B = A;\n" });
    generate(root);
    expect(lint(root)).toEqual([
      'layouts/AppLayout.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/layouts/Settings.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/views/Inline.tsx:1 typescript(no-import-type-side-effects)',
      'modules/auth/views/Login.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/views/settings/Tokens.tsx:1 eslint(no-restricted-imports)',
    ]);
  });

  it('--boundaries: a module imports another one only through its entry — at every depth, not in tests', () => {
    const root = app({ ...CLIENT, ...MODULES, 'modules/auth/views/Cross.tsx': "import { totals } from '../../billing/deep/er/Totals.ts';\nexport const x = totals;\n" });
    generate(root, { boundaries: true });
    expect(lint(root)).toEqual([
      'layouts/AppLayout.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/a/b/c/Deep.ts:1 eslint(no-restricted-imports)',
      'modules/auth/layouts/Settings.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/listeners/SendWelcome.ts:1 eslint(no-restricted-imports)',
      'modules/auth/sessions.ts:1 eslint(no-restricted-imports)',
      'modules/auth/sessions.ts:2 eslint(no-restricted-imports)',
      'modules/auth/views/Cross.tsx:1 eslint(no-restricted-imports)', // a view gets both rules
      'modules/auth/views/Inline.tsx:1 typescript(no-import-type-side-effects)',
      'modules/auth/views/Login.tsx:1 eslint(no-restricted-imports)',
      'modules/auth/views/settings/Tokens.tsx:1 eslint(no-restricted-imports)',
    ]);
  });

  it('covers as many folder levels as the app has, at least eight', () => {
    const depthOf = (config: Record<string, unknown>) => (config.overrides as { files: string[] }[]).filter((override) => /^modules\/\*\/(\*\/)*\*$/.test(override.files[0]!)).length;
    expect(depthOf(lintConfig({ boundaries: true }))).toBe(8);
    expect(depthOf(lintConfig({ boundaries: false }))).toBe(0);
    const root = app({ 'modules/auth/1/2/3/4/5/6/7/8/9/Deep.ts': "import { totals } from '../../../../../../../../../../billing/deep/er/Totals.ts';\nexport const x = totals;\n" });
    generate(root, { boundaries: true });
    expect(lint(root)).toEqual(['modules/auth/1/2/3/4/5/6/7/8/9/Deep.ts:1 eslint(no-restricted-imports)']);
  });
});
