import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, NO_DIRECTORY, USAGE, type Io } from './main.ts';
import { appManifest, filesUnder, PNPM_VERSION, readTarEntry, TEMPLATE, TEMPLATE_TITLE, writeTitle } from './template.ts';
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
  }, 15_000);

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
    expect(run.out).toContain('npm install\n  npx marmeon migrate\n  npx marmeon make:docker');
    expect(readFileSync(join(app, '.env'), 'utf8')).toMatch(/^APP_NAME="Asked App"$/m);
  });
});

describe('create-marmeon — the app', () => {
  it('--minimal writes the blank app: every file as apps/blank-app has it — package.json, tsconfig.json, README and the keys aside', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['blank', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const app = join(cwd, 'blank');
    const own = new Set(['package.json', 'tsconfig.json', 'README.md', 'index.html', '.env', '.env.test']);
    expect(filesUnder(app).filter((file) => file !== '.env')).toEqual([...new Set([...blankAppFiles(), 'README.md'])].sort());
    for (const file of blankAppFiles().filter((name) => !own.has(name))) {
      expect(readFileSync(join(app, file), 'utf8'), file).toBe(readFileSync(join(blank, file), 'utf8'));
    }
    // index.html: the blank app's, with the app's name as its title — never the framework's.
    const html = readFileSync(join(app, 'index.html'), 'utf8');
    expect(/<title>(.*)<\/title>/.exec(html)?.[1], 'the title of a new app').not.toMatch(/Marmeon/);
    expect(html).toBe(readFileSync(join(blank, 'index.html'), 'utf8').replace(TEMPLATE_TITLE, '<title>Blank</title>'));
    // .env.test: the blank app's, with a test key of the app's own.
    const withoutKey = (text: string) => text.replace(/^APP_KEY=.*$/m, 'APP_KEY=');
    expect(withoutKey(readFileSync(join(app, '.env.test'), 'utf8'))).toBe(withoutKey(readFileSync(join(blank, '.env.test'), 'utf8')));

    // package.json: the blank app's — its name, every @marmeon/* and the CLI (marmeon) at this package's version, pnpm pinned.
    const expected = JSON.parse(readFileSync(join(blank, 'package.json'), 'utf8')) as Record<string, any>;
    const written = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, any>;
    const { name: _name, description: _description, dependencies, devDependencies, ...rest } = expected;
    const pinned = (list: Record<string, string>) => Object.fromEntries(Object.entries(list).map(([name, range]) => [name, framework(name) ? ownVersion : range]));
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
    const pinned = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) => framework(name));
    expect(pinned.length).toBeGreaterThan(15);
    expect(pinned.filter(([, range]) => range !== ownVersion)).toEqual([]);
    expect(manifest.dependencies.marmeon, 'the CLI (the unscoped marmeon) at this version').toBe(ownVersion);
    expect(readFileSync(join(cwd, 'with-npm/README.md'), 'utf8')).toContain('npm run dev');
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
    expect(readFileSync(join(cwd, 'one/.gitignore'), 'utf8')).toMatch(/^\.env$/m);
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
    expect(run.out).toContain('pnpm install\n  pnpm exec marmeon make:auth\n  pnpm exec marmeon migrate\n  pnpm exec marmeon make:docker');
    expect(readFileSync(join(cwd, 'kit/README.md'), 'utf8')).toContain('private: one answer for new and known addresses');
  });

  it('titles the document with the app\'s name — escaped; the blank app stays neutral', () => {
    expect(readFileSync(join(blank, 'index.html'), 'utf8')).toContain(TEMPLATE_TITLE);
    const app = workspace();
    writeFileSync(join(app, 'index.html'), `<head>${TEMPLATE_TITLE}</head>`);
    writeTitle(app, 'Fish & <Chips>');
    expect(readFileSync(join(app, 'index.html'), 'utf8')).toBe('<head><title>Fish &amp; &lt;Chips&gt;</title></head>');
    expect(() => writeTitle(app, 'Again')).toThrow('<title>App</title> is missing in index.html');
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

describe('the starter kit’s own files', () => {
  it('its client is the blank app’s — with its dialog (`confirm: Confirm`) and nothing else', () => {
    const base = readFileSync(join(TEMPLATE, 'base/bootstrap/client.tsx'), 'utf8');
    const kit = readFileSync(join(TEMPLATE, 'kit/bootstrap/client.tsx'), 'utf8');
    const dialog = /^import \{ Confirm \} from '\.\/confirm\.tsx';\n|^\/\/ `confirm`: .*\n(?:\/\/ .*\n)?|, confirm: Confirm/gm;
    expect(kit).not.toBe(base);
    expect(kit.replace(dialog, '')).toBe(base);
  });
});

/**
 * The starter kit as a user gets it: the template and the home module, then the app's own `make:auth` and `migrate` —
 * type-checked, linted with the app's preset, and its tests (auth, home, system) pass. The framework from the workspace (the
 * blank app's node_modules); `pnpm pack:smoke` does the same from the tarballs, outside the monorepo.
 */
it(
  'the starter kit works: make:auth, migrate, typecheck, lint and its tests pass',
  async () => {
    const cwd = workspace();
    expect((await create(cwd, ['kit', '--no-install', '--no-git'])).code).toBe(0);
    const root = join(cwd, 'kit');
    symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV') delete env[key];
    const { DB_CONNECTION: _connection, DB_URL: _url, ...sqliteEnv } = env;
    // Plain text whatever the CI colours: the assertions match the child Vitest's summary.
    const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
      const result = spawnSync(command, args, { cwd: root, env: { ...base, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }, encoding: 'utf8', timeout: 240_000 });
      return { code: result.status, out: stripVTControlCharacters(`${result.stdout}${result.stderr}`) };
    };
    // As the scaffolder runs them after the install: NODE_ENV from the app's .env (development).
    const marmeon = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), ...args], {}, sqliteEnv);
    expect(marmeon('make:auth')).toMatchObject({ code: 0, out: expect.stringContaining('Wrote bootstrap/routes.ts') });
    expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'home': { method: 'get'; path: '/'; controller: typeof ShowHomeController };");
    expect(marmeon('migrate')).toMatchObject({ code: 0, out: expect.stringContaining('Environment: development (APP_ENV=local, NODE_ENV from .env)') });
    const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
    expect(typecheck.out).toBe('');
    expect(typecheck.code).toBe(0);
    expect(run(join(root, 'node_modules/.bin/oxlint'), ['--deny-warnings'])).toMatchObject({ code: 0 });
    const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native', '--reporter=verbose'], { NODE_OPTIONS: '--conditions=@marmeon/source', NODE_ENV: 'test' });
    expect(tests.out).toContain('modules/home/home.test.ts');
    // The app's dialog in the page's language: the guard's question — and tab sync's — in German too.
    expect(tests.out).toContain('modules/home/confirm.test.ts');
    // The failing tests by name — the message (Vitest shortens a long output it prints).
    const failed = tests.out.split('\n').filter((line) => /^\s*(×|FAIL)/.test(line)).join('\n');
    expect(tests.out, `the kit's tests failed:\n${failed}`).toMatch(/Tests\s+\d+ passed \(\d+\)/);
    expect(tests.out, `the kit's tests failed:\n${failed}`).not.toMatch(/Tests\s+\d+ failed/);
    expect(tests.code).toBe(0);
  },
  300_000,
);
