import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, NO_DIRECTORY, USAGE, type Io } from './main.ts';
import { appManifest, appPath, filesUnder, KIT_DEV_DEPENDENCIES, nameTitles, PERSONALIZED, PNPM_VERSION, readTarEntry, stubSets, TEMPLATE, TEMPLATE_APP_CONSTANT, TEMPLATE_TITLE, writeStubManifest, writeTitle } from './template.ts';
import { readStubManifest, recordStubSet, STUB_MANIFEST, stubHash } from '@marmeon/core/internal';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');
const ownVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
/** The framework's packages: the scope and the unscoped CLI — spelled out here, not taken from template.ts. */
const framework = (name: string) => name.startsWith('@marmeon/') || name === 'marmeon';

function workspace(): string {
  const dir = tempDir('marmeon-create-');
  return dir;
}

/** A run of create-marmeon with streams of its own: no terminal unless `answers` are given (then both ends are "TTYs"). */
async function create(cwd: string, argv: string[], { answers, env = {} }: { answers?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: answers !== undefined });
  const stdout = Object.assign(new PassThrough(), { isTTY: answers !== undefined });
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk;
    // A question ends with a space and no newline: answer it.
    if (answers && /[?:)] $/.test(out)) stdin.write(`${answers.shift() ?? ''}\n`);
  });
  stderr.on('data', (chunk: Buffer) => (err += chunk));
  const io: Io = { argv, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, cwd, stdin, stdout, stderr };
  const code = await main(io);
  return { code, out, err };
}

/** The blank app's files as git has them (tracked and new — never .env, node_modules, …). */
function blankAppFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: blank, encoding: 'utf8' });
  return listed.stdout.split('\n').filter((file) => file && existsSync(join(blank, file))).sort();
}

describe('create-marmeon — the call', () => {
  it('without a directory and without a terminal: exit 2 and the reason, at once — it never waits for an answer', async () => {
    // stdin stays open — a pipe nobody writes to and nobody closes, as in a CI job: a prompt would wait for good.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { main } = await import(${JSON.stringify(join(repo, 'packages/create-marmeon/src/main.ts'))}); process.exitCode = await main();`], {
      cwd: workspace(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    const ended = await new Promise<number | string>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve('still waiting after 10 s');
      }, 10_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    child.stdin.end();
    expect(ended).toBe(USAGE);
    expect(stderr.trim()).toBe(NO_DIRECTORY);
  });

  it('refuses wrong calls with exit 2 — an unknown flag, two directories, two package managers', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['app', '--yse'])).code).toBe(USAGE);
    expect((await create(cwd, ['one', 'two'])).code).toBe(USAGE);
    expect((await create(cwd, ['app', '--npm', '--pnpm'])).err).toContain('choose one package manager');
    expect(existsSync(join(cwd, 'app'))).toBe(false);
    const help = await create(cwd, ['--help']);
    expect([help.code, help.out]).toEqual([0, expect.stringContaining('Usage: create-marmeon <dir> [options]')]);
    expect((await create(cwd, ['--version'])).out.trim()).toBe(ownVersion);
  });

  it('never writes into a directory that has files (exit 1)', async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken', 'notes.txt'), 'mine\n');
    const run = await create(cwd, ['taken', '--yes', '--no-install', '--no-git']);
    expect([run.code, run.err.trim()]).toEqual([1, 'create-marmeon: taken is not empty — choose a new directory.']);
    expect(filesUnder(join(cwd, 'taken'))).toEqual(['notes.txt']);
  });

  it('asks on a terminal — directory, starter kit, Docker, package manager, git — and does what the answers say', async () => {
    const cwd = workspace();
    const run = await create(cwd, ['--no-install'], { answers: ['Asked App', 'n', 'y', 'npm', 'n'] });
    expect(run.code).toBe(0);
    expect(run.out).toContain('Directory of the new app (my-app):');
    const app = join(cwd, 'Asked App');
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect([manifest.name, manifest.packageManager]).toEqual(['asked-app', undefined]);
    expect(existsSync(join(app, 'modules/home'))).toBe(false);
    expect(existsSync(join(app, '.git'))).toBe(false);
    // Without the install the generators are the next steps — make:docker among them (the Docker answer).
    expect(run.out).toContain('npm install\n  npx marmeon agents:sync\n  npx marmeon migrate\n  npx marmeon make:docker');
    expect(readFileSync(join(app, '.env'), 'utf8')).toMatch(/^APP_NAME="Asked App"$/m);
  });
});

describe('create-marmeon — the app', () => {
  it('--minimal writes the blank app: every file as apps/blank-app has it — package.json, tsconfig.json, README and the keys aside', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['blank', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const app = join(cwd, 'blank');
    const own = new Set(['package.json', 'tsconfig.json', 'README.md', 'index.html', 'bootstrap/head.ts', '.env', '.env.test']);
    expect(filesUnder(app).filter((file) => file !== '.env')).toEqual([...new Set([...blankAppFiles(), 'README.md', 'marmeon-stubs.json', 'pnpm-workspace.yaml'])].sort());
    for (const file of blankAppFiles().filter((name) => !own.has(name))) {
      expect(readFileSync(join(app, file), 'utf8'), file).toBe(readFileSync(join(blank, file), 'utf8'));
    }
    // index.html: the blank app's, with the app's name as its title — never the framework's.
    const html = readFileSync(join(app, 'index.html'), 'utf8');
    expect(/<title>(.*)<\/title>/.exec(html)?.[1], 'the title of a new app').not.toMatch(/Marmeon/);
    expect(html).toBe(readFileSync(join(blank, 'index.html'), 'utf8').replace(TEMPLATE_TITLE, '<title>Blank</title>'));
    // bootstrap/head.ts: the blank app's, with the app's name in the title template.
    expect(readFileSync(join(app, 'bootstrap/head.ts'), 'utf8')).toBe(readFileSync(join(blank, 'bootstrap/head.ts'), 'utf8').replace(TEMPLATE_APP_CONSTANT, 'const APP = "Blank";'));
    // .env.test: the blank app's, with a test key of the app's own.
    const withoutKey = (text: string) => text.replace(/^APP_KEY=.*$/m, 'APP_KEY=');
    expect(withoutKey(readFileSync(join(app, '.env.test'), 'utf8'))).toBe(withoutKey(readFileSync(join(blank, '.env.test'), 'utf8')));

    // package.json: the blank app's — its name, every @marmeon/* and the CLI (marmeon) at this package's version, pnpm pinned.
    const expected = JSON.parse(readFileSync(join(blank, 'package.json'), 'utf8')) as Record<string, any>;
    const written = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, any>;
    const { name: _name, description: _description, dependencies, devDependencies, ...rest } = expected;
    const pinned = (list: Record<string, string>) => Object.fromEntries(Object.entries(list).map(([name, range]) => [name, framework(name) ? ownVersion : range]));
    // `pnpm add @marmeon/x` saves the exact version, as every @marmeon/* package must have the app's.
    expect(readFileSync(join(app, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/^saveExact: true$/m);
    expect(written).toEqual({ ...rest, name: 'blank', packageManager: `pnpm@${PNPM_VERSION}`, dependencies: pinned(dependencies), devDependencies: pinned(devDependencies) });
    expect(JSON.stringify(written)).not.toMatch(/workspace:|"latest"|"\*"/);

    // tsconfig.json: standalone — the blank app's own options on top of the repository's shared ones, without the source condition.
    const tsconfig = JSON.parse(readFileSync(join(app, 'tsconfig.json'), 'utf8')) as { extends?: string; compilerOptions: Record<string, unknown>; include: string[] };
    const blankTsconfig = JSON.parse(readFileSync(join(blank, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions).toMatchObject({ ...blankTsconfig.compilerOptions, strict: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true });
    expect(tsconfig.compilerOptions.customConditions).toBeUndefined();
    expect(tsconfig.include).toEqual(blankTsconfig.include);
    // Nothing points back into the monorepo (its shared tsconfig, its workspace ranges).
    expect(JSON.stringify(filesUnder(app).map((file) => readFileSync(join(app, file), 'utf8')))).not.toMatch(/tsconfig\.base\.json|workspace:|apps\/blank-app/);
  });

  it('pins every @marmeon/* and the CLI to its own version; with --npm nothing of pnpm\'s', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['with-npm', '--npm', '--no-install', '--no-git'])).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, 'with-npm/package.json'), 'utf8')) as Record<string, any>;
    expect(manifest.packageManager).toBeUndefined();
    expect(existsSync(join(cwd, 'with-npm/pnpm-workspace.yaml'))).toBe(false);
    // `npm install @marmeon/x` saves the exact version, as every @marmeon/* package must have the app's.
    expect(readFileSync(join(cwd, 'with-npm/.npmrc'), 'utf8')).toMatch(/^save-exact=true$/m);
    const pinned = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) => framework(name));
    expect(pinned.length).toBeGreaterThan(15);
    expect(pinned.filter(([, range]) => range !== ownVersion)).toEqual([]);
    expect(manifest.dependencies.marmeon, 'the CLI (the unscoped marmeon) at this version').toBe(ownVersion);
    expect(readFileSync(join(cwd, 'with-npm/README.md'), 'utf8')).toContain('npm run dev');
    expect(readFileSync(join(cwd, 'with-npm/README.md'), 'utf8')).toContain('The guides of your version: node_modules/marmeon/docs (`marmeon docs`); the newest online: https://marmeon.com/docs');
  });

  it('writes APP_KEY into .env only (owner-readable) — never the template, never .env.example; each app its own keys', async () => {
    for (const file of filesUnder(TEMPLATE)) {
      expect(file).not.toMatch(/(^|\/)\.env$/);
      expect(readFileSync(join(TEMPLATE, file), 'utf8'), file).not.toMatch(/^APP_KEY=\S/m);
    }
    const cwd = workspace();
    for (const name of ['one', 'two']) expect((await create(cwd, [name, '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const key = (app: string, file: string) => /^APP_KEY=(.*)$/m.exec(readFileSync(join(cwd, app, file), 'utf8'))?.[1];
    expect(key('one', '.env')).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(key('one', '.env.example')).toBe('');
    expect(key('one', '.env')).not.toBe(key('two', '.env'));
    expect(key('one', '.env.test')).not.toBe(key('two', '.env.test'));
    expect(key('one', '.env.test')).not.toBe(key('one', '.env'));
    expect(statSync(join(cwd, 'one/.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cwd, 'one/.gitignore'), 'utf8')).toMatch(/^\.env\*$/m);
  });

  it('ignores every .env file of a new app except .env.example and .env.test', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['ignored', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const app = join(cwd, 'ignored');
    // A global ignore file of the machine must not hide a missing entry.
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/dev/null' };
    expect(spawnSync('git', ['init', '--quiet'], { cwd: app, env }).status).toBe(0);
    const ignored = (file: string) => spawnSync('git', ['check-ignore', '--quiet', file], { cwd: app, env }).status === 0;
    for (const file of ['.env', '.env.production', '.env.local', '.env.staging']) expect(ignored(file), file).toBe(true);
    for (const file of ['.env.example', '.env.test']) expect(ignored(file), file).toBe(false);
  });

  it('the starter kit adds the home module, registered — and names the generators when it does not install', async () => {
    const cwd = workspace();
    // Registration is private by default, AUTH_PRIVATE_REGISTRATION=false turns it off: there is no flag for it.
    const refused = await create(cwd, ['flagged', '--private-registration', '--no-install', '--no-git']);
    expect(refused.code).toBe(USAGE);
    expect(refused.err).toContain("Unknown option '--private-registration'");
    expect(existsSync(join(cwd, 'flagged'))).toBe(false);
    const run = await create(cwd, ['kit', '--docker', '--no-install', '--no-git']);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    for (const file of ['modules/home/index.ts', 'modules/home/routes.ts', 'modules/home/views/Home.tsx', 'modules/home/home.test.ts']) expect(existsSync(join(cwd, 'kit', file)), file).toBe(true);
    const app = readFileSync(join(cwd, 'kit/bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import home from '#modules/home';\nimport system from '#modules/system';");
    expect(app).toContain('modules: [home, system]');
    expect(run.out).toContain('pnpm install\n  pnpm exec marmeon agents:sync\n  pnpm exec marmeon make:auth\n  pnpm exec marmeon migrate\n  pnpm exec marmeon make:docker');
    expect(readFileSync(join(cwd, 'kit/README.md'), 'utf8')).toContain('private: one answer for new and known addresses');
  });

  it('the starter kit ships every language it supports in every module — a locale with a lang file is supported, and a missing one falls back to English in the middle of a page', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    // What the app has once `make:auth` ran: its own modules and the auth stubs, one directory of language files each.
    const stubs = join(repo, 'packages/auth/stubs/react/modules');
    const langDirs = [...filesUnder(join(cwd, 'kit')).map((file) => join(cwd, 'kit', file)), ...filesUnder(stubs).map((file) => join(stubs, file))]
      .filter((file) => /(^|[/\\])lang[/\\][^/\\]+\.ts$/.test(file) && !file.includes('node_modules'))
      .map((file) => dirname(file));
    const dirs = [...new Set(langDirs)];
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    const locales = new Set(dirs.flatMap((dir) => readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => file.replace(/\.ts$/, ''))));
    expect([...locales].sort()).toEqual(['de', 'en']);
    const paths = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, child]) => paths(child, `${prefix}${key}.`)) : [prefix];
    for (const dir of dirs) {
      const source = paths(((await import(pathToFileURL(join(dir, 'en.ts')).href)) as { default: unknown }).default).sort();
      for (const locale of locales) {
        expect(existsSync(join(dir, `${locale}.ts`)), `${dir} has no ${locale}.ts`).toBe(true);
        const other = paths(((await import(pathToFileURL(join(dir, `${locale}.ts`)).href)) as { default: unknown }).default).sort();
        expect(other, `${dir}/${locale}.ts`).toEqual(source);
      }
    }
  });

  it('titles the document with the app\'s name — escaped; the blank app stays neutral', () => {
    expect(readFileSync(join(blank, 'index.html'), 'utf8')).toContain(TEMPLATE_TITLE);
    const app = workspace();
    writeFileSync(join(app, 'index.html'), `<head>${TEMPLATE_TITLE}</head>`);
    writeTitle(app, 'Fish & <Chips>');
    expect(readFileSync(join(app, 'index.html'), 'utf8')).toBe('<head><title>Fish &amp; &lt;Chips&gt;</title></head>');
    expect(() => writeTitle(app, 'Again')).toThrow('<title>App</title> is missing in index.html');
  });

  it('names the app in its title template — any name stays a valid string literal', () => {
    expect(readFileSync(join(blank, 'bootstrap/head.ts'), 'utf8')).toContain(TEMPLATE_APP_CONSTANT);
    const app = workspace();
    mkdirSync(join(app, 'bootstrap'));
    writeFileSync(join(app, 'bootstrap/head.ts'), `${TEMPLATE_APP_CONSTANT}\nexport { APP };\n`);
    const name = `It's "a" \\ </script> \` line\nbreak  `;
    nameTitles(app, name);
    const written = readFileSync(join(app, 'bootstrap/head.ts'), 'utf8');
    const literal = /^const APP = (.*);\nexport \{ APP \};\n$/s.exec(written)?.[1];
    expect(literal, 'the literal is on one line of its own').toBeDefined();
    expect(JSON.parse(literal!)).toBe(name);
    expect(() => nameTitles(app, 'Again')).toThrow('must be in bootstrap/head.ts exactly once');
    writeFileSync(join(app, 'bootstrap/head.ts'), `${TEMPLATE_APP_CONSTANT}\n${TEMPLATE_APP_CONSTANT}\n`);
    expect(() => nameTitles(app, 'Twice')).toThrow('must be in bootstrap/head.ts exactly once');
  });

  it('pins the pnpm the repository uses — and make:docker installs the same one', () => {
    const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { packageManager: string };
    expect(`pnpm@${PNPM_VERSION}`).toBe(root.packageManager);
    expect(readFileSync(join(repo, 'packages/cli/src/docker.ts'), 'utf8')).toContain(`export const TESTED_PNPM = '${PNPM_VERSION}';`);
  });

  it('keeps its template equal to the blank app (pnpm template:sync)', () => {
    const check = spawnSync(process.execPath, [join(repo, 'scripts/sync-template.ts'), '--check'], { cwd: repo, encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });
});

describe('create-marmeon — the framework from tarballs (MARMEON_CREATE_TARBALLS, maintainers)', () => {
  /** A tarball as pnpm pack names it (`@marmeon/core` → `marmeon-core-0.0.0.tgz`, `marmeon` → `marmeon-0.0.0.tgz`), holding `package/package.json`. */
  function tarball(dir: string, name: string, dependencies: Record<string, string> = {}): void {
    const short = name.replace(/^@/, '').replace('/', '-');
    const source = join(dir, 'src', short, 'package');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '0.0.0', dependencies }));
    expect(spawnSync('tar', ['-czf', join(dir, `${short}-0.0.0.tgz`), '-C', join(dir, 'src', short), 'package']).status).toBe(0);
  }

  it('vendors them into the app; npm overrides what gets installed by relative path, the optional peers nobody installs by absolute path, pnpm only what gets installed', async () => {
    const cwd = workspace();
    const tarballs = join(cwd, 'tarballs');
    mkdirSync(tarballs);
    const template = JSON.parse(readFileSync(join(TEMPLATE, 'base/_package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of [...Object.keys(template.dependencies), ...Object.keys(template.devDependencies)].filter(framework)) {
      tarball(tarballs, name, name === 'marmeon' ? { '@marmeon/encryption': '0.0.0' } : {});
    }
    tarball(tarballs, '@marmeon/encryption');
    tarball(tarballs, '@marmeon/redis');
    expect(readTarEntry(join(tarballs, 'marmeon-0.0.0.tgz'), 'package/package.json')).toContain('"@marmeon/encryption"');

    expect((await create(cwd, ['vendored', '--npm', '--minimal', '--no-install', '--no-git'], { env: { MARMEON_CREATE_TARBALLS: tarballs } })).code).toBe(0);
    const app = join(cwd, 'vendored');
    expect(existsSync(join(app, 'vendor/marmeon/marmeon-redis-0.0.0.tgz'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(manifest.dependencies!['@marmeon/core']).toBe('file:./vendor/marmeon/marmeon-core-0.0.0.tgz');
    expect(manifest.dependencies!.marmeon, 'the CLI from its tarball').toBe('file:./vendor/marmeon/marmeon-0.0.0.tgz');
    expect(manifest.overrides!['@marmeon/core']).toBe('file:./vendor/marmeon/marmeon-core-0.0.0.tgz');
    expect(manifest.overrides!['@marmeon/encryption']).toBe('file:./vendor/marmeon/marmeon-encryption-0.0.0.tgz'); // cli's dependency
    expect(manifest.overrides!['@marmeon/redis']).toBe(`file:${join(app, 'vendor/marmeon/marmeon-redis-0.0.0.tgz')}`); // nobody installs it

    expect((await create(cwd, ['vendored-pnpm', '--minimal', '--no-install', '--no-git'], { env: { MARMEON_CREATE_TARBALLS: tarballs } })).code).toBe(0);
    const workspaceFile = readFileSync(join(cwd, 'vendored-pnpm/pnpm-workspace.yaml'), 'utf8');
    expect(workspaceFile).toContain('"@marmeon/core": "file:./vendor/marmeon/marmeon-core-0.0.0.tgz"');
    expect(workspaceFile).toContain('"@marmeon/encryption": "file:./vendor/marmeon/marmeon-encryption-0.0.0.tgz"'); // cli's dependency
    // An overridden optional peer is installed by pnpm as if the app had asked for it — what nobody installs stays out.
    expect(workspaceFile).not.toContain('@marmeon/redis');
    expect(workspaceFile).toContain('hoistPattern: []');
    expect(workspaceFile).toMatch(/^saveExact: true$/m);
  });

  it('turns a template manifest into the app\'s without touching anything but the framework', () => {
    const manifest = appManifest(JSON.stringify({ name: 'x', version: '0.0.0', description: 'gone', dependencies: { '@marmeon/core': 'workspace:*', react: '^19' } }), {
      name: 'mine',
      packageManager: 'pnpm',
      source: { version: '1.2.3' },
    });
    expect(manifest).toEqual({ name: 'mine', version: '0.0.0', packageManager: `pnpm@${PNPM_VERSION}`, dependencies: { '@marmeon/core': '1.2.3', react: '^19' } });
  });
});

describe('create-marmeon — marmeon-stubs.json', () => {
  type Written = { format: number; sets: Record<string, { package: string; version: string; files: Record<string, { stub: string; sha256: string }> }> };
  const manifestOf = (app: string) => JSON.parse(readFileSync(join(app, 'marmeon-stubs.json'), 'utf8')) as Written;
  const templateFiles = (part: 'base' | 'kit') => filesUnder(join(TEMPLATE, part)).map((file) => ({ file, path: appPath(file) }));

  it('records two sets for a kit app and only the base for --minimal, at this package\'s version', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    expect((await create(cwd, ['bare', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const kit = manifestOf(join(cwd, 'kit'));
    expect(kit.format).toBe(1);
    expect(Object.keys(kit.sets)).toEqual(['create-marmeon:base', 'create-marmeon:kit']);
    expect(Object.keys(manifestOf(join(cwd, 'bare')).sets)).toEqual(['create-marmeon:base']);
    for (const set of Object.values(kit.sets)) expect(set).toMatchObject({ package: 'create-marmeon', version: ownVersion });
    expect(kit.sets['create-marmeon:kit']!.files['styles/app.css']).toMatchObject({ stub: 'template/kit/styles/app.css' });
    expect(kit.sets['create-marmeon:base']!.files['.gitignore']).toMatchObject({ stub: 'template/base/_gitignore' });
  });

  it('leaves out the files that are personalized and the migrations; every other file of the template is in it', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    const recorded = new Set(Object.values(manifestOf(join(cwd, 'kit')).sets).flatMap((set) => Object.keys(set.files)));
    for (const path of PERSONALIZED) expect(recorded.has(path), path).toBe(false);
    expect([...recorded].filter((path) => /^modules\/[^/]+\/migrations\//.test(path))).toEqual([]);
    // A new file in the template is recorded, or someone says here why it is not.
    for (const { file, path } of [...templateFiles('base'), ...templateFiles('kit')]) {
      const skipped = PERSONALIZED.includes(path) || /^modules\/[^/]+\/migrations\//.test(path);
      expect(recorded.has(path) || skipped, file).toBe(true);
    }
    // A file the kit overwrites is in the kit's set alone.
    const sets = Object.values(manifestOf(join(cwd, 'kit')).sets);
    const all = sets.flatMap((set) => Object.keys(set.files));
    expect(new Set(all).size).toBe(all.length);
  });

  it('a file both parts hold belongs to the kit only', () => {
    const template = tempDir('marmeon-create-template-');
    for (const [part, file] of [['base', 'a.txt'], ['base', 'shared.txt'], ['kit', 'shared.txt'], ['kit', 'b.txt']] as const) {
      mkdirSync(join(template, part), { recursive: true });
      writeFileSync(join(template, part, file), `${part}\n`);
    }
    const [base, kit] = stubSets(true, template);
    expect(base!.files).toEqual([{ path: 'a.txt', stub: 'template/base/a.txt' }]);
    expect(kit!.files.map((file) => file.path)).toEqual(['b.txt', 'shared.txt']);
  });

  it('holds the hash of every file as it lies in the app, line endings aside', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    const app = join(cwd, 'kit');
    const sets = manifestOf(app).sets;
    for (const set of Object.values(sets)) {
      for (const [path, { stub, sha256 }] of Object.entries(set.files)) {
        expect(sha256, path).toBe(stubHash(readFileSync(join(app, path))));
        // … and the template has those very bytes: nothing was changed on the way (the stub is relative to this package).
        expect(sha256, stub).toBe(stubHash(readFileSync(new URL(`../${stub}`, import.meta.url))));
      }
    }
  });

  it('hashes, sorts and writes like core for a CRLF file, files out of order and an empty set', () => {
    const dir = tempDir('marmeon-create-crlf-');
    writeFileSync(join(dir, 'z.txt'), 'a\r\nb\r\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub/a.txt'), 'a\nb\n');
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 255, 13, 10, 128]));
    const files = [{ path: 'z.txt', stub: 'template/base/z.txt' }, { path: 'sub/a.txt', stub: 'template/base/sub/a.txt' }, { path: 'b.bin', stub: 'template/base/b.bin' }];
    writeStubManifest(dir, [{ key: 'create-marmeon:kit', files: [] }, { key: 'create-marmeon:base', files }], '0.0.0');
    const mine = readFileSync(join(dir, STUB_MANIFEST), 'utf8');
    rmSync(join(dir, STUB_MANIFEST));
    expect(recordStubSet(dir, 'create-marmeon:kit', { package: 'create-marmeon', version: '0.0.0', files: [] }).ok).toBe(true);
    expect(recordStubSet(dir, 'create-marmeon:base', { package: 'create-marmeon', version: '0.0.0', files }).ok).toBe(true);
    expect(readFileSync(join(dir, STUB_MANIFEST), 'utf8')).toBe(mine);
    expect(stubHash(Buffer.from('a\r\nb\n'))).toBe(stubHash(Buffer.from('a\nb\n')));
  });

  it('writes the bytes recordStubSet of @marmeon/core writes, and the reader of core takes it', async () => {
    const cwd = workspace();
    for (const argv of [['kit'], ['bare', '--minimal']]) {
      expect((await create(cwd, [...argv, '--no-install', '--no-git'])).code).toBe(0);
      const app = join(cwd, argv[0]!);
      const written = readFileSync(join(app, 'marmeon-stubs.json'), 'utf8');
      const read = readStubManifest(app);
      expect(read.ok, argv[0]).toBe(true);
      const copy = tempDir('marmeon-create-copy-');
      for (const set of Object.values(manifestOf(app).sets)) for (const path of Object.keys(set.files)) {
        mkdirSync(join(copy, path, '..'), { recursive: true });
        writeFileSync(join(copy, path), readFileSync(join(app, path)));
      }
      for (const [key, set] of Object.entries(manifestOf(app).sets)) {
        const files = Object.entries(set.files).map(([path, { stub }]) => ({ path, stub }));
        expect(recordStubSet(copy, key, { package: set.package, version: set.version, files }).ok).toBe(true);
      }
      expect(readFileSync(join(copy, STUB_MANIFEST), 'utf8')).toBe(written);
    }
  });
});

describe('the starter kit’s own files', () => {
  it('a kit app has the look — styles/app.css, imported once, and the font as a dependency the blank app does not have', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    expect((await create(cwd, ['blank', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    expect(existsSync(join(cwd, 'kit/styles/app.css'))).toBe(true);
    expect(readFileSync(join(cwd, 'kit/bootstrap/client.tsx'), 'utf8').match(/import '\.\.\/styles\/app\.css'/g)).toHaveLength(1);
    const font = '@fontsource-variable/ibm-plex-sans';
    const kit = JSON.parse(readFileSync(join(cwd, 'kit/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const minimal = JSON.parse(readFileSync(join(cwd, 'blank/package.json'), 'utf8')) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    expect(kit.devDependencies[font]).toBe(KIT_DEV_DEPENDENCIES[font]);
    expect(Object.keys(kit.devDependencies)).toEqual([...Object.keys(kit.devDependencies)].sort());
    expect(font in minimal.devDependencies || font in minimal.dependencies).toBe(false);
    expect(existsSync(join(cwd, 'blank/styles'))).toBe(false);
  });

  it('pins the font to the version the website uses, and the stylesheet imports exactly that package', () => {
    const website = JSON.parse(readFileSync(join(repo, 'apps/website/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(KIT_DEV_DEPENDENCIES['@fontsource-variable/ibm-plex-sans']).toBe(website.devDependencies['@fontsource-variable/ibm-plex-sans']);
    expect(readFileSync(join(TEMPLATE, 'kit/styles/app.css'), 'utf8')).toContain("@import '@fontsource-variable/ibm-plex-sans/wght.css';");
  });

  it('preloads the font and gives it a stand-in of matching size: the config names both, the client imports it, the stack uses it', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    const config = readFileSync(join(cwd, 'kit/vite.config.ts'), 'utf8');
    expect(config).toContain("file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2', family: 'IBM Plex Sans Variable', fallback: 'Arial'");
    expect(readFileSync(join(cwd, 'kit/bootstrap/client.tsx'), 'utf8')).toContain("import 'virtual:marmeon/fonts.css';");
    expect(readFileSync(join(cwd, 'kit/styles/app.css'), 'utf8')).toContain("--font-text: 'IBM Plex Sans Variable', 'IBM Plex Sans Variable Fallback', system-ui");
    // The blank app keeps its plain config.
    expect((await create(cwd, ['blank', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    expect(readFileSync(join(cwd, 'blank/vite.config.ts'), 'utf8')).not.toContain('fonts');
  });

  it('the stylesheet defines every token it uses, keeps the mono font a system stack, and respects dark mode and reduced motion', () => {
    const css = readFileSync(join(TEMPLATE, 'kit/styles/app.css'), 'utf8');
    const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]));
    const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]!);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
    expect(css).toMatch(/--font-mono: ui-monospace/);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: reduce');
    // No bare `button` rule with a background or border: the framework's components are buttons too and keep their look.
    for (const [, selector, body] of css.matchAll(/^([^\n{}@/][^{}]*)\{([^{}]*)\}/gm)) {
      const bare = selector!.split(',').some((part) => /^\s*button(:[\w-]+)?\s*$/.test(part));
      if (bare) expect(body, `\`${selector!.trim()}\``).not.toMatch(/background|border|color|padding/);
    }
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
  });

  it('the kit’s views and the auth stubs carry no style attribute — the look is a stylesheet (a strict style-src blocks inline styles)', () => {
    const stubs = join(repo, 'packages/auth/stubs/react');
    const files = [
      ...filesUnder(join(TEMPLATE, 'kit')).filter((file) => file.endsWith('.tsx')).map((file) => join(TEMPLATE, 'kit', file)),
      ...filesUnder(stubs).filter((file) => file.endsWith('.tsx')).map((file) => join(stubs, file)),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bstyle=/);
    // No <br /> as layout (a label above its input is the stylesheet's job). The settings pages (Security, AccessTokens) still
    // use it between label and input, so they are not checked here.
    const laidOut = files.filter((name) => /(layouts|views)[/\\](?!Security|AccessTokens)[^/\\]+\.tsx$/.test(name) && name.startsWith(stubs));
    expect(laidOut.length).toBeGreaterThan(5);
    for (const file of laidOut) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<br\s*\/?>/);
  });

  it('its client is the blank app’s — with its dialog (`confirm: Confirm`), its stylesheets and nothing else', () => {
    const base = readFileSync(join(TEMPLATE, 'base/bootstrap/client.tsx'), 'utf8');
    const kit = readFileSync(join(TEMPLATE, 'kit/bootstrap/client.tsx'), 'utf8');
    const dialog = /^import 'virtual:marmeon\/fonts\.css';.*\n|^\/\/ app\.css first: .*\n|^import '\.\.\/styles\/app\.css';.*\n|^import \{ Confirm \} from '\.\.\/layouts\/Confirm\.tsx';\n|^\/\/ `confirm`: .*\n(?:\/\/ .*\n)?|, confirm: Confirm/gm;
    expect(kit).not.toBe(base);
    expect(kit.replace(dialog, '')).toBe(base);
  });
});
