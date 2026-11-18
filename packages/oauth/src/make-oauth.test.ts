import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthServiceProvider } from '@marmeon/auth';
import { AUTH_STUBS } from '@marmeon/auth/internal';
import { readStubManifest, stubHash } from '@marmeon/core/internal';
import { describe, expect, it } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { MakeOAuthCommand, NEEDED, NEEDED_FOR_TESTS, STUBS } from './make-oauth.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');

/** A copy of the blank app, without its installed packages: the generator reads files and a package.json, and runs nothing of the app. */
function blankApp(): string {
  const dir = workspaceTempDir('marmeon-make-oauth-');
  cpSync(blank, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !source.endsWith('.env') });
  return dir;
}

function fakeInput(root: string, options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const spawned: string[][] = [];
  const output = {
    success: (line: string) => lines.push(`✓ ${line}`),
    info: (line: string) => lines.push(`i ${line}`),
    warn: (line: string) => lines.push(`! ${line}`),
    error: (line: string) => lines.push(`✗ ${line}`),
    line: (line = '') => lines.push(line),
  };
  const spawn = async (...args: string[]) => (spawned.push(args), 0);
  return { input: { root, args: [], options, output, spawn } as never, lines, spawned };
}

/** Every file under `directory` (relative, with `/`) with the hash of its content. */
function filesOf(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/')] = createHash('sha256').update(readFileSync(join(entry.parentPath, entry.name))).digest('hex');
  }
  return files;
}

const OWN = (path: string) => path.startsWith('modules/oauth/') || path === 'bootstrap/app.ts' || path === 'marmeon-stubs.json';

describe('make:oauth', () => {
  it('writes only below modules/oauth and registers the module in bootstrap/app.ts', async () => {
    const root = blankApp();
    const before = filesOf(root);
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    const after = filesOf(root);
    const added = Object.keys(after).filter((path) => !(path in before));
    expect(added.filter((path) => !OWN(path))).toEqual([]);
    expect(added).toContain('modules/oauth/index.ts');
    expect(added).toContain('modules/oauth/controllers/OAuthCallbackController.ts');
    expect(added).toContain('modules/oauth/views/SignInButtons.tsx');
    expect(added).toContain('modules/oauth/sign-in.test.ts');
    expect(added).toContain('modules/oauth/connected-accounts.test.ts');
    expect(added).toContain('modules/oauth/confirm.test.ts');
    expect(added).toContain('modules/oauth/views/ConnectedAccounts.tsx');
    expect(added).toContain('modules/oauth/views/ConfirmButtons.tsx');
    expect(added).toContain('modules/oauth/listeners/NotifyAboutSocialAccountLinked.ts');
    for (const file of ['mail/SocialAccountLinkedMail.ts', 'mail/SocialAccountLinkedView.tsx', 'controllers/ShowConnectedAccountsController.ts', 'controllers/LinkSocialAccountController.ts', 'controllers/UnlinkSocialAccountController.ts', 'controllers/ConfirmWithProviderController.ts', 'controllers/ShowConfirmButtonsController.ts']) {
      expect(added).toContain(`modules/oauth/${file}`);
    }
    expect(lines).toContain('Tests: modules/oauth/sign-in.test.ts, modules/oauth/connected-accounts.test.ts, modules/oauth/confirm.test.ts');
    const app = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import oauth from '#modules/oauth';");
    expect(app).toMatch(/modules: \[system, oauth\]/);
    expect(lines[0]).toMatch(/^✓ Created modules\/oauth \(\d+ files\)$/);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
    // The blank app lacks @marmeon/oauth, so the route types wait for the install.
    expect(spawned).toEqual([]);
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^Install what the module uses: pnpm add -E @marmeon\/oauth@<version of your app>/)]));
    // How the buttons get onto a page is told, not done: no insertion line for the sign-in or settings pages.
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('<Island route="oauth.sign-in" />')]));
    // The panel and the confirm buttons are placed the same way.
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('<Island route="oauth.accounts" />')]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('<Island route="oauth.confirm-options" />')]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('OAUTH_GITHUB_CLIENT_ID')]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('modules/oauth/targets.ts')]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('modules/oauth/SocialUsers.ts')]));
    expect(lines.join('\n')).not.toMatch(/Login\.tsx|Security\.tsx|settings page/);
  });

  it('leaves every other file of the app byte for byte as it was', async () => {
    const root = blankApp();
    writeFileSync(join(root, 'modules/system/README.md'), 'mine\n');
    const before = filesOf(root);
    expect(await new MakeOAuthCommand().handle(fakeInput(root).input)).toBe(0);
    const after = filesOf(root);
    for (const [path, hash] of Object.entries(before)) {
      if (!OWN(path)) expect(after[path], path).toBe(hash);
    }
    // Nothing disappeared either.
    expect(Object.keys(before).filter((path) => !(path in after))).toEqual([]);
  });

  it('prints the line when bootstrap/app.ts cannot be edited, and writes the module all the same', async () => {
    const root = blankApp();
    const bootstrap = join(root, 'bootstrap/app.ts');
    const source = readFileSync(bootstrap, 'utf8').replace('modules: [system]', 'modules: appModules');
    writeFileSync(bootstrap, source);
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    expect(readFileSync(bootstrap, 'utf8')).toBe(source);
    expect(existsSync(join(root, 'modules/oauth/index.ts'))).toBe(true);
    expect(lines.some((line) => line.startsWith('! Not registered — '))).toBe(true);
    expect(lines).toContain('Register the module in bootstrap/app.ts:');
    expect(lines).toContain("  import oauth from '#modules/oauth';");
    expect(spawned).toEqual([]);
  });

  it('writes no migration: the table comes with make:social-accounts-table', async () => {
    const root = blankApp();
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    expect(existsSync(join(root, 'modules/oauth/migrations'))).toBe(false);
    expect(Object.keys(filesOf(root)).filter((path) => path.includes('social_accounts'))).toEqual([]);
    const publish = lines.findIndex((line) => line.includes('marmeon make:social-accounts-table'));
    expect(publish).toBeGreaterThan(-1);
    expect(lines[publish]).toContain('marmeon migrate');
    expect(lines.some((line) => line.includes('marmeon publish'))).toBe(false);
  });

  it('names the password migration only when no module has it, and never writes it', async () => {
    const root = blankApp();
    const named = (lines: string[]) => lines.filter((line) => line.includes('make_users_password_optional'));
    const first = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(first.input)).toBe(0);
    const [line] = named(first.lines);
    expect(line).toContain('into the migrations of the module that owns users');
    // The path it names is the kit's template, which exists.
    const template = /copy (\S+) into/.exec(line!)![1]!;
    expect(existsSync(template.startsWith('/') ? template : join(root, template))).toBe(true);
    expect(template.startsWith(join(AUTH_STUBS, 'react', 'modules', 'auth', 'migrations')) || template.includes('stubs/react/modules/auth/migrations/')).toBe(true);
    expect(Object.keys(filesOf(root)).filter((path) => path.includes('make_users_password_optional'))).toEqual([]);

    // Any module that has the migration, under any timestamp, makes the note unnecessary.
    mkdirSync(join(root, 'modules/accounts/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/accounts/migrations/2026_01_01_000000_make_users_password_optional.ts'), '// the app\'s own\n');
    const second = fakeInput(root, { force: true });
    expect(await new MakeOAuthCommand().handle(second.input)).toBe(0);
    expect(named(second.lines)).toEqual([]);
    expect(readdirSync(join(root, 'modules/accounts/migrations'))).toEqual(['2026_01_01_000000_make_users_password_optional.ts']);
  });

  it('refuses an existing modules/oauth without --force', async () => {
    const root = blankApp();
    await new MakeOAuthCommand().handle(fakeInput(root).input);
    writeFileSync(join(root, 'modules/oauth/routes.ts'), '// changed by the app\n');
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(1);
    expect(lines).toEqual(['✗ modules/oauth already exists. It is yours now — pass --force to overwrite it with the templates.']);
    expect(readFileSync(join(root, 'modules/oauth/routes.ts'), 'utf8')).toBe('// changed by the app\n');
    expect(await new MakeOAuthCommand().handle(fakeInput(root, { force: true }).input)).toBe(0);
    expect(readFileSync(join(root, 'modules/oauth/routes.ts'), 'utf8')).not.toBe('// changed by the app\n');
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').match(/#modules\/oauth/g)).toHaveLength(1); // registered once
  });

  it('refuses a path that leads out of the project, before writing anything', async () => {
    const root = blankApp();
    const outside = tempDir('marmeon-make-oauth-outside-');
    symlinkSync(outside, join(root, 'modules/oauth'), 'dir');
    const bootstrap = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    const { input, lines, spawned } = fakeInput(root, { force: true });
    expect(await new MakeOAuthCommand().handle(input)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✗ modules\/oauth leads out of the project, and make:oauth would write through it\..*Nothing was written\.$/);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toBe(bootstrap);
    expect(existsSync(join(root, 'marmeon-stubs.json'))).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('writes no module when marmeon-stubs.json is of a newer Marmeon', async () => {
    const root = blankApp();
    const newer = '{"format":2,"sets":{}}\n';
    writeFileSync(join(root, 'marmeon-stubs.json'), newer);
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(1);
    expect(lines).toEqual(['✗ marmeon-stubs.json was written by a newer Marmeon — update the packages.']);
    expect(existsSync(join(root, 'modules/oauth'))).toBe(false);
    expect(readFileSync(join(root, 'marmeon-stubs.json'), 'utf8')).toBe(newer);
  });

  it('records the set in marmeon-stubs.json', async () => {
    const root = blankApp();
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    const version = (JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }).version;
    expect(lines).toContain(`✓ Recorded the module's files in marmeon-stubs.json (version ${version})`);
    const manifest = readStubManifest(root);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const set = manifest.value?.sets['@marmeon/oauth:react/modules/oauth'];
    expect(set).toMatchObject({ package: '@marmeon/oauth', version });
    const templates = join(STUBS, 'react', 'modules', 'oauth');
    const expected = Object.keys(filesOf(templates)).sort();
    expect(expected.length).toBeGreaterThan(10);
    expect(Object.keys(set!.files).sort()).toEqual(expected.map((file) => `modules/oauth/${file}`));
    for (const [path, entry] of Object.entries(set!.files)) {
      expect(entry.sha256, path).toBe(stubHash(readFileSync(join(root, path))));
      expect(entry.stub).toBe(`stubs/react/${path}`);
    }
    // Only this set: the leftovers of a later run are looked for in it alone.
    expect(Object.keys(manifest.value!.sets)).toEqual(['@marmeon/oauth:react/modules/oauth']);
  });

  it("removes a file an earlier version shipped and the app left unchanged, only from this module's own set", async () => {
    const root = blankApp();
    await new MakeOAuthCommand().handle(fakeInput(root).input);
    // An earlier version shipped modules/oauth/old.ts; another set lists a file of the app's, which this run must not touch.
    const { recordStubSet } = await import('@marmeon/core/internal');
    writeFileSync(join(root, 'modules/oauth/old.ts'), 'old\n');
    writeFileSync(join(root, 'modules/system/other.ts'), 'other\n');
    const manifest = readStubManifest(root);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const key = '@marmeon/oauth:react/modules/oauth';
    recordStubSet(root, key, { package: '@marmeon/oauth', version: '0.0.1', files: [...Object.entries(manifest.value!.sets[key]!.files).map(([path, entry]) => ({ path, stub: entry.stub })), { path: 'modules/oauth/old.ts', stub: 'stubs/react/modules/oauth/old.ts' }] });
    recordStubSet(root, 'other:set', { package: 'other', version: '1.0.0', files: [{ path: 'modules/system/other.ts', stub: 'x' }] });
    const { input, lines } = fakeInput(root, { force: true });
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    expect(existsSync(join(root, 'modules/oauth/old.ts'))).toBe(false);
    expect(lines.some((line) => line.startsWith('✓ Removed modules/oauth/old.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/system/other.ts'))).toBe(true);
  });

  it("names every package its templates import — the module's in NEEDED, its tests' in NEEDED_FOR_TESTS", () => {
    const imported = (test: boolean) => {
      const names = new Set<string>();
      for (const file of readdirSync(join(STUBS, 'react'), { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) !== test) continue;
        for (const [, specifier] of readFileSync(join(STUBS, 'react', file), 'utf8').matchAll(/(?:from|import)\s+'([^'.#][^']*)'/g)) {
          if (specifier!.startsWith('node:')) continue;
          const parts = specifier!.split('/');
          names.add(specifier!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
        }
      }
      return [...names].sort();
    };
    const module = imported(false);
    expect(module).toContain('@marmeon/oauth');
    expect(module.filter((name) => !NEEDED.includes(name))).toEqual([]);
    expect(imported(true).filter((name) => !NEEDED.includes(name) && !NEEDED_FOR_TESTS.includes(name))).toEqual([]);
    // The client of the providers is not imported by a template but the module cannot sign anybody in without it.
    expect(NEEDED).toContain('@marmeon/fetch');
  });

  it('knows its adapters', async () => {
    const { input, lines } = fakeInput(blankApp(), { adapter: 'vue' });
    await expect(new MakeOAuthCommand().handle(input)).rejects.toMatchObject({ name: 'CommandArgumentsError', message: 'There are no oauth templates for the UI adapter "vue". Known: react.' });
    expect(lines).toEqual([]);
  });

  describe('a link inside the project', () => {
    // `escapesRoot` stops a link that leaves the project; one that stays inside would still make `cpSync` overwrite another file of the app.
    const cases: [string, (root: string) => void, { force: boolean }][] = [
      ['modules/oauth itself', (root) => (mkdirSync(join(root, 'modules/elsewhere')), symlinkSync(join(root, 'modules/elsewhere'), join(root, 'modules/oauth'), 'dir')), { force: true }],
      ['modules', (root) => (cpSync(join(root, 'modules'), join(root, 'real-modules'), { recursive: true }), rmSync(join(root, 'modules'), { recursive: true }), symlinkSync(join(root, 'real-modules'), join(root, 'modules'), 'dir')), { force: false }],
      ['a directory of the module', (root) => (mkdirSync(join(root, 'modules/oauth')), mkdirSync(join(root, 'modules/elsewhere')), symlinkSync(join(root, 'modules/elsewhere'), join(root, 'modules/oauth/controllers'), 'dir')), { force: true }],
      ['a file of the module', (root) => (mkdirSync(join(root, 'modules/oauth')), symlinkSync(join(root, 'README.md'), join(root, 'modules/oauth/sign-in.test.ts'))), { force: true }],
      ['bootstrap/app.ts', (root) => (writeFileSync(join(root, 'real-app.ts'), readFileSync(join(root, 'bootstrap/app.ts'))), rmSync(join(root, 'bootstrap/app.ts')), symlinkSync(join(root, 'real-app.ts'), join(root, 'bootstrap/app.ts'))), { force: false }],
      ['marmeon-stubs.json', (root) => (writeFileSync(join(root, 'real-stubs.json'), '{"format":1,"sets":{}}\n'), symlinkSync(join(root, 'real-stubs.json'), join(root, 'marmeon-stubs.json'))), { force: false }],
    ];
    it.each(cases)('refuses %s as a link, and writes nothing', async (_name, link, options) => {
      const root = blankApp();
      link(root);
      const before = filesOf(root);
      const { input, lines, spawned } = fakeInput(root, options);
      expect(await new MakeOAuthCommand().handle(input)).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^✗ \S+ is a link, and make:oauth would write through it\..*Nothing was written\.$/);
      expect(filesOf(root)).toEqual(before);
      expect(spawned).toEqual([]);
    });
  });

  it('refuses an app without config/app.ts, and writes nothing', async () => {
    const root = blankApp();
    rmSync(join(root, 'config/app.ts'));
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(1);
    expect(lines).toEqual(['✗ The templates need config/app.ts exporting AppConfig (APP_NAME, APP_URL) — the app skeleton has one.']);
    expect(existsSync(join(root, 'modules/oauth'))).toBe(false);
  });

  it('refuses an adapter that is a path', async () => {
    // `../stubs/react` leads to a directory that exists, so only the pattern of the adapter name can refuse it.
    expect(existsSync(join(STUBS, '../stubs/react', 'modules', 'oauth'))).toBe(true);
    const root = blankApp();
    const before = filesOf(root);
    const { input, lines } = fakeInput(root, { adapter: '../stubs/react' });
    await expect(new MakeOAuthCommand().handle(input)).rejects.toMatchObject({ name: 'CommandArgumentsError', message: expect.stringContaining('for the UI adapter "../stubs/react"') });
    expect(lines).toEqual([]);
    expect(filesOf(root)).toEqual(before);
  });

  describe('what the app still needs', () => {
    const packageJson = (root: string, change: (pkg: { dependencies: Record<string, string>; devDependencies: Record<string, string> }) => void) => {
      const file = join(root, 'package.json');
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      change(pkg);
      writeFileSync(file, JSON.stringify(pkg, null, 2));
    };

    it('generates the route types when every package is there, and then does not tell to', async () => {
      const root = blankApp();
      packageJson(root, (pkg) => {
        for (const name of [...NEEDED, ...NEEDED_FOR_TESTS]) if (!(name in pkg.dependencies) && !(name in pkg.devDependencies)) pkg.dependencies[name] = 'workspace:*';
      });
      const { input, lines, spawned } = fakeInput(root);
      expect(await new MakeOAuthCommand().handle(input)).toBe(0);
      expect(spawned).toEqual([['route:types']]);
      expect(lines.filter((line) => line.startsWith('Then: marmeon route:types'))).toEqual([]);
      expect(lines.filter((line) => line.startsWith('Install what the module uses'))).toEqual([]);
    });

    it("reports what the module's tests use, and what the app has as a dev dependency but production needs", async () => {
      const root = blankApp();
      packageJson(root, (pkg) => {
        delete pkg.devDependencies['@marmeon/testing'];
        pkg.devDependencies['marmeon'] = pkg.dependencies['marmeon']!;
        delete pkg.dependencies['marmeon'];
      });
      const { input, lines } = fakeInput(root);
      expect(await new MakeOAuthCommand().handle(input)).toBe(0);
      expect(lines).toContain('And what its tests use: pnpm add -E -D @marmeon/testing@<version of your app>');
      expect(lines).toContain('Production needs these as dependencies, not dev dependencies: pnpm add -E marmeon@<version of your app>');
    });

    it('names what compiles the mail view, oxc-transform, only while the app lacks it', async () => {
      const line = 'And what compiles its mail view: pnpm add -D oxc-transform';
      const root = blankApp();
      let version = '';
      packageJson(root, (pkg) => {
        version = pkg.devDependencies['oxc-transform']!;
        delete pkg.devDependencies['oxc-transform'];
      });
      const without = fakeInput(root);
      expect(await new MakeOAuthCommand().handle(without.input)).toBe(0);
      expect(without.lines).toContain(line);
      packageJson(root, (pkg) => void (pkg.devDependencies['oxc-transform'] = version));
      const withIt = fakeInput(root, { force: true });
      expect(await new MakeOAuthCommand().handle(withIt.input)).toBe(0);
      expect(withIt.lines).not.toContain(line);
    });
  });

  it('counts a hand-written import of the module as registered even when the modules list is not written out', async () => {
    const root = blankApp();
    const bootstrap = join(root, 'bootstrap/app.ts');
    const source = readFileSync(bootstrap, 'utf8').replace('modules: [system]', 'modules: appModules').replace("import system from '#modules/system';", "import system from '#modules/system';\nimport oauth from '#modules/oauth';");
    writeFileSync(bootstrap, source);
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    expect(readFileSync(bootstrap, 'utf8')).toBe(source);
    expect(lines.some((line) => line.includes('Not registered'))).toBe(false);
    expect(lines).not.toContain('Register the module in bootstrap/app.ts:');
  });

  it('does not name the password migration after make:auth, which wrote it under its own name', async () => {
    const root = blankApp();
    const Auth = AuthServiceProvider.commands!.find((command) => command.command === 'make:auth')! as unknown as new () => { handle(input: unknown): Promise<number> };
    expect(await new Auth().handle(fakeInput(root).input)).toBe(0);
    expect(readdirSync(join(root, 'modules/auth/migrations'))).toContain('0001_01_01_000008_make_users_password_optional.ts');
    const { input, lines } = fakeInput(root);
    expect(await new MakeOAuthCommand().handle(input)).toBe(0);
    expect(lines.filter((line) => line.includes('make_users_password_optional'))).toEqual([]);
  });
});
