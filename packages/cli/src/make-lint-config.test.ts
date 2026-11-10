import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINT_CONFIG_FILE, lintConfig, MakeLintConfigCommand, serverModulesFingerprint, specifierPatterns } from './commands/make-lint-config.ts';
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

  it("lets an event be a type of its own: `readonly #event = true` (make:event's shape) is never read, and no warning says so", () => {
    const root = app({ 'modules/auth/events/Registered.ts': 'export class Registered {\n  readonly #event = true;\n  readonly id: number;\n  constructor(id: number) {\n    this.id = id;\n  }\n}\n' });
    expect(generate(root).code).toBe(0);
    const result = spawnSync(oxlint, ['--deny-warnings', '-f', 'unix', '.'], { cwd: root, encoding: 'utf8' });
    expect(result.stdout).not.toContain('no-unused-private-class-members');
    expect(result.status).toBe(0);
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

  it("forbids @marmeon/<package>/internal in every file, tests included — the pattern is in the top-level rule and in every override", () => {
    const patternsOf = (rules: Record<string, unknown>) => (rules['no-restricted-imports'] as [string, { patterns: { regex?: string }[] }])[1].patterns;
    for (const boundaries of [false, true]) {
      const config = lintConfig({ boundaries }) as { rules: Record<string, unknown>; overrides: { files: string[]; rules: Record<string, unknown> }[] };
      for (const rules of [config.rules, ...config.overrides.map((override) => override.rules)]) {
        expect(patternsOf(rules).map((pattern) => pattern.regex)).toContain('^@marmeon/[^/]+/internal(?:/|$)');
      }
    }
  });

  for (const boundaries of [false, true]) {
    it(`oxlint fails an import of an internal subpath in modules, tests and the client entry, not of an entry (boundaries: ${boundaries})`, () => {
      const root = app({
        'modules/auth/x.ts': "import { x } from '@marmeon/http/internal';\nexport const y = x;\n",
        'modules/auth/x.test.ts': "import { x } from '@marmeon/http/internal';\nexport const y = x;\n",
        'modules/auth/views/V.tsx': "import { x } from '@marmeon/core/internal/deep';\nexport const y = x;\n",
        'bootstrap/client.tsx': "import { x } from '@marmeon/http/internal';\nexport const y = x;\n",
        'modules/auth/fine.ts': "import { a } from '@marmeon/http';\nimport { b } from '@marmeon/http/client';\nimport { c } from '@marmeon/internals';\nexport const y = [a, b, c];\n",
      });
      generate(root, { boundaries });
      expect(lint(root)).toEqual([
        'bootstrap/client.tsx:1 eslint(no-restricted-imports)',
        'modules/auth/views/V.tsx:1 eslint(no-restricted-imports)',
        'modules/auth/x.test.ts:1 eslint(no-restricted-imports)',
        'modules/auth/x.ts:1 eslint(no-restricted-imports)',
      ]);
    });
  }

  it('covers as many folder levels as the app has, at least eight', () => {
    const depthOf = (config: Record<string, unknown>) => (config.overrides as { files: string[] }[]).filter((override) => /^modules\/\*\/(\*\/)*\*$/.test(override.files[0]!)).length;
    expect(depthOf(lintConfig({ boundaries: true }))).toBe(8);
    expect(depthOf(lintConfig({ boundaries: false }))).toBe(0);
    const root = app({ 'modules/auth/1/2/3/4/5/6/7/8/9/Deep.ts': "import { totals } from '../../../../../../../../../../billing/deep/er/Totals.ts';\nexport const x = totals;\n" });
    generate(root, { boundaries: true });
    expect(lint(root)).toEqual(['modules/auth/1/2/3/4/5/6/7/8/9/Deep.ts:1 eslint(no-restricted-imports)']);
  });
});

describe('specifierPatterns — a server glob as the specifiers that reach it from a folder', () => {
  it('cuts the glob at every folder the importing file shares with it', () => {
    expect(specifierPatterns(['modules', '*', '*'], 'modules/*/jobs/**')).toEqual(['../../../modules/*/jobs/**', '../../*/jobs/**', '../jobs/**']);
    expect(specifierPatterns(['modules', '*', '*'], 'modules/billing/invoices/**')).toEqual(['../../../modules/billing/invoices/**', '../../billing/invoices/**']);
    expect(specifierPatterns(['modules', 'billing', '*'], 'modules/billing/invoices/**')).toEqual([
      '../../../modules/billing/invoices/**',
      '../../billing/invoices/**',
      '../invoices/**',
    ]);
    expect(specifierPatterns(['bootstrap'], 'bootstrap/app.ts')).toEqual(['../bootstrap/app.ts', './app.ts']);
  });

  it('keeps a glob that starts with ** as it is: it matches at any depth', () => {
    expect(specifierPatterns(['layouts', '*'], '**/*Gateway.ts')).toEqual(['**/*Gateway.ts']);
  });
});

describe('marmeon make:lint-config — the server folders of package.json and the conventions, per depth', () => {
  const declared = ['modules/billing/invoices/**', '!modules/auth/jobs/labels.ts'];
  const withDeclaration = (files: Record<string, string>, serverModules: unknown = declared) =>
    app({
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', imports: { '#modules/*': './modules/*/index.ts' }, marmeon: { serverModules } }),
      'modules/billing/invoices/ShowInvoiceController.ts': 'export class ShowInvoiceController {}\n',
      'modules/billing/invoices/InvoiceTable.tsx': 'export const InvoiceTable = 1;\n',
      'modules/auth/jobs/labels.ts': 'export const labels = 1;\n',
      'modules/notes/jobs/labels.ts': 'export const labels = 1;\n',
      'modules/auth/jobs/SendWelcome.ts': 'export const SendWelcome = 1;\n',
      'modules/billing/views/subscriptions/Index.tsx': "import { InvoiceTable } from '../invoices/InvoiceTable.tsx';\nexport default InvoiceTable;\n",
      'modules/todo/tasks/List.tsx': 'export const List = 1;\n',
      'modules/todo/views/tasks/List.tsx': 'export const List = 1;\n',
      'modules/todo/views/Index.tsx': "import { List } from './tasks/List.tsx';\nexport default List;\n",
      'bootstrap/app.ts': 'export const app = 1;\n',
      ...files,
    });

  const VALUE = {
    'modules/billing/views/invoices/Show.tsx': "import { ShowInvoiceController } from '../../invoices/ShowInvoiceController.ts';\nexport const c = ShowInvoiceController;\n",
    'layouts/App.tsx': "import { ShowInvoiceController } from '../modules/billing/invoices/ShowInvoiceController.ts';\nexport const c = ShowInvoiceController;\n",
    'modules/auth/views/Other.tsx': "import { ShowInvoiceController } from '../../billing/invoices/ShowInvoiceController.ts';\nexport const c = ShowInvoiceController;\n",
    'modules/billing/views/Direct.tsx': "import { ShowInvoiceController } from '../invoices/ShowInvoiceController.ts';\nexport const c = ShowInvoiceController;\n",
    // The conventions the preset did not know: jobs, a module's entry, config, the app's definition.
    'modules/auth/views/Job.tsx': "import { SendWelcome } from '../jobs/SendWelcome.ts';\nexport const c = SendWelcome;\n",
    'modules/auth/views/Entry.tsx': "import { UserRepository } from '../index.ts';\nexport const c = UserRepository;\n",
    'modules/auth/views/Config.tsx': "import { AppConfig } from '../../../config/app.ts';\nexport const c = AppConfig;\n",
    'modules/auth/views/App.tsx': "import { app } from '../../../bootstrap/app.ts';\nexport const c = app;\n",
    'bootstrap/client.tsx': "import { app } from './app.ts';\nexport const c = app;\n",
    // The negation holds for auth only.
    'modules/notes/views/X.tsx': "import { labels } from '../jobs/labels.ts';\nexport const c = labels;\n",
  };
  const TYPES = {
    'modules/billing/views/invoices/Typed.tsx': "import type { ShowInvoiceController } from '../../invoices/ShowInvoiceController.ts';\nexport type C = ShowInvoiceController;\n",
    'modules/auth/views/Typed.tsx': "import type { SendWelcome } from '../jobs/SendWelcome.ts';\nexport type C = typeof SendWelcome;\n",
    'modules/auth/views/Negated.tsx': "import { labels } from '../jobs/labels.ts';\nexport const c = labels;\n",
    // Not server code: a view folder named like a feature folder, a view folder named like a convention, another module's folder.
    'modules/auth/views/Y.tsx': "import { InvoiceTable } from '../invoices/InvoiceTable.tsx';\nexport default InvoiceTable;\n",
  };

  for (const boundaries of [false, true]) {
    it(`flags a value import of a declared folder or a convention from views, layouts and the client entry — and no view folder (boundaries: ${boundaries})`, () => {
      const root = withDeclaration({
        ...VALUE,
        ...TYPES,
        'modules/auth/views/Y.tsx': "import { InvoiceTable } from '../invoices/InvoiceTable.tsx';\nexport default InvoiceTable;\n",
        'modules/billing/views/invoices/Fine.tsx': "export default 1;\n",
      });
      expect(generate(root, { boundaries }).code).toBe(0);
      // An import reported by the boundary rule and the server rule counts once.
      const flagged = [...new Set(lint(root).filter((line) => !line.includes('no-import-type-side-effects')).map((line) => line.split(':')[0]))];
      expect(flagged).toEqual(Object.keys(VALUE).sort());
    });
  }

  it('--boundaries: a negated file does not open the way out of the module — an import across modules stays a boundary error', () => {
    const files = {
      'modules/notes/views/Across.tsx': "import { labels } from '../../auth/jobs/labels.ts';\nexport const c = labels;\n",
      'modules/notes/views/ViaRoot.tsx': "import { labels } from '../../../modules/auth/jobs/labels.ts';\nexport const c = labels;\n",
      'modules/auth/views/Own.tsx': "import { labels } from '../jobs/labels.ts';\nexport const c = labels;\n",
    };
    const flagged = (boundaries: boolean) => {
      const root = withDeclaration(files);
      generate(root, { boundaries });
      return [...new Set(lint(root).map((line) => line.split(':')[0]))];
    };
    expect(flagged(true)).toEqual(['modules/notes/views/Across.tsx', 'modules/notes/views/ViaRoot.tsx']);
    expect(flagged(false)).toEqual([]);
  });

  it('--boundaries: the same one folder deeper — a negated file stays free inside its module, not across', () => {
    const root = withDeclaration({
      'modules/auth/views/sub/Negated.tsx': "import { labels } from '../../jobs/labels.ts';\nexport const c = labels;\n",
      'modules/notes/views/sub/Across.tsx': "import { labels } from '../../../auth/jobs/labels.ts';\nexport const c = labels;\n",
    });
    generate(root, { boundaries: true });
    expect([...new Set(lint(root).map((line) => line.split(':')[0]))]).toEqual(['modules/notes/views/sub/Across.tsx']);
  });

  it('reaches a declared folder through #modules/ too, and keeps the conventions it always flagged', () => {
    const root = withDeclaration({
      'modules/billing/views/invoices/Entry.tsx': "import { Invoices } from '#modules/billing';\nexport const c = Invoices;\n",
      'modules/auth/views/Repo.tsx': "import { UserRepository } from '../UserRepository.ts';\nexport const c = UserRepository;\n",
      'modules/auth/views/Provider.tsx': "import { P } from '../AuthServiceProvider.ts';\nexport const c = P;\n",
      'modules/auth/views/Ctl.tsx': "import { ShowLoginController } from '../controllers/ShowLoginController.ts';\nexport const c = ShowLoginController;\n",
    });
    generate(root);
    expect([...new Set(lint(root).map((line) => line.split(':')[0]))]).toEqual([
      'modules/auth/views/Ctl.tsx',
      'modules/auth/views/Provider.tsx',
      'modules/auth/views/Repo.tsx',
      'modules/billing/views/invoices/Entry.tsx',
    ]);
  });

  it('keeps flagging controllers in a view deeper than the overrides cover (the fallback)', () => {
    const root = withDeclaration({ 'modules/auth/views/1/2/3/4/5/6/7/8/9/Deep.tsx': "import { c } from '../../../../../../../../../../../controllers/X.ts';\nexport const x = c;\n" });
    generate(root);
    expect(lint(root).map((line) => line.split(':')[0])).toContain('modules/auth/views/1/2/3/4/5/6/7/8/9/Deep.tsx');
  });

  for (const boundaries of [false, true]) {
    it(`flags a declared folder at the app root from every depth, and lets a test import the app's definition (boundaries: ${boundaries})`, () => {
      const root = withDeclaration(
        {
          'domain/pricing/Rates.ts': 'export const rates = 1;\n',
          'domain/Gateway.ts': 'export const gateway = 1;\n',
          'modules/billing/views/Domain.tsx': "import { rates } from '../../../domain/pricing/Rates.ts';\nexport const c = rates;\n",
          'modules/billing/views/deep/er/Domain.tsx': "import { rates } from '../../../../../domain/pricing/Rates';\nexport const c = rates;\n",
          'modules/billing/views/Gateway.tsx': "import { gateway } from '../../../domain/Gateway.ts';\nexport const c = gateway;\n",
          'modules/billing/views/Typed.tsx': "import type { rates } from '../../../domain/pricing/Rates.ts';\nexport type C = typeof rates;\n",
          'modules/billing/views/Docs.tsx': "import { x } from '../../../documents/Rates.ts';\nexport const c = x;\n",
          'documents/Rates.ts': 'export const x = 1;\n',
          'modules/billing/layouts/Frame.test.ts': "import { app } from '../../../bootstrap/app.ts';\nexport const c = app;\n",
          'modules/billing/views/Page.test.ts': "import { app } from '../../../bootstrap/app.ts';\nexport const c = app;\n",
          'layouts/App.test.ts': "import { app } from '../bootstrap/app.ts';\nexport const c = app;\n",
        },
        ['domain/**', '**/*Gateway.ts'],
      );
      generate(root, { boundaries });
      expect([...new Set(lint(root).map((line) => line.split(':')[0]))]).toEqual([
        'modules/billing/views/Domain.tsx',
        'modules/billing/views/Gateway.tsx',
        'modules/billing/views/deep/er/Domain.tsx',
      ]);
    });
  }

  it('writes no file for a broken declaration, and says H14', () => {
    const root = withDeclaration({}, 'modules/billing/invoices/**');
    const result = generate(root);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toMatch(/^✗ \[marmeon:H14\] package\.json: "marmeon"\."serverModules" is not a list of globs/);
    expect(existsSync(join(root, LINT_CONFIG_FILE))).toBe(false);
  });

  it('names what the preset was written for in its header: a fingerprint that follows the declaration', () => {
    const header = (root: string) => /\/\/ marmeon:server-modules ([0-9a-f]{16}) /.exec(readFileSync(join(root, LINT_CONFIG_FILE), 'utf8'))?.[1];
    const one = withDeclaration({});
    generate(one);
    const two = withDeclaration({}, ['modules/billing/payments/**']);
    generate(two);
    expect(header(one)).toBe(serverModulesFingerprint(declared));
    expect(header(two)).toBe(serverModulesFingerprint(['modules/billing/payments/**']));
    expect(header(one)).not.toBe(header(two));
  });
});
