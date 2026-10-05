import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, NO_DIRECTORY, USAGE, type Io } from './main.ts';
import { appManifest, filesUnder, PNPM_VERSION, readTarEntry, TEMPLATE } from './template.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');
const ownVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function workspace(): string {
  const dir = tempDir('bespoke-create-');
  return dir;
}

/** A run of create-bespoke-app with streams of its own: no terminal unless `answers` are given (then both ends are "TTYs"). */
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

describe('create-bespoke-app — the call', () => {
  it('without a directory and without a terminal: exit 2 and the reason, at once — it never waits for an answer (E167)', async () => {
    // stdin stays open — a pipe nobody writes to and nobody closes, as in a CI job: a prompt would wait for good.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { main } = await import(${JSON.stringify(join(repo, 'packages/create-bespoke-app/src/main.ts'))}); process.exitCode = await main();`], {
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

  it('refuses wrong calls with exit 2 — an unknown flag, two directories, two package managers, --private-registration with --minimal', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['app', '--yse'])).code).toBe(USAGE);
    expect((await create(cwd, ['one', 'two'])).code).toBe(USAGE);
    expect((await create(cwd, ['app', '--npm', '--pnpm'])).err).toContain('choose one package manager');
    const both = await create(cwd, ['app', '--minimal', '--private-registration']);
    expect([both.code, both.err.trim()]).toEqual([USAGE, 'create-bespoke-app: --private-registration is an option of the starter kit (make:auth) — leave out --minimal.']);
    expect(existsSync(join(cwd, 'app'))).toBe(false);
    const help = await create(cwd, ['--help']);
    expect([help.code, help.out]).toEqual([0, expect.stringContaining('Usage: create-bespoke-app <dir> [options]')]);
    expect((await create(cwd, ['--version'])).out.trim()).toBe(ownVersion);
  });

  it('never writes into a directory that has files (exit 1)', async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken', 'notes.txt'), 'mine\n');
    const run = await create(cwd, ['taken', '--yes', '--no-install', '--no-git']);
    expect([run.code, run.err.trim()]).toEqual([1, 'create-bespoke-app: taken is not empty — choose a new directory.']);
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
    expect(run.out).toContain('npm install\n  npx bespoke migrate\n  npx bespoke make:docker');
    expect(readFileSync(join(app, '.env'), 'utf8')).toMatch(/^APP_NAME="Asked App"$/m);
  });
});

describe('create-bespoke-app — the app', () => {
  it('--minimal writes the blank app: every file as apps/blank-app has it (E167) — package.json, tsconfig.json, README and the keys aside', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['blank', '--minimal', '--no-install', '--no-git'])).code).toBe(0);
    const app = join(cwd, 'blank');
    const own = new Set(['package.json', 'tsconfig.json', 'README.md', '.env', '.env.test']);
    expect(filesUnder(app).filter((file) => file !== '.env')).toEqual([...new Set([...blankAppFiles(), 'README.md'])].sort());
    for (const file of blankAppFiles().filter((name) => !own.has(name))) {
      expect(readFileSync(join(app, file), 'utf8'), file).toBe(readFileSync(join(blank, file), 'utf8'));
    }
    // .env.test: the blank app's, with a test key of the app's own.
    const withoutKey = (text: string) => text.replace(/^APP_KEY=.*$/m, 'APP_KEY=');
    expect(withoutKey(readFileSync(join(app, '.env.test'), 'utf8'))).toBe(withoutKey(readFileSync(join(blank, '.env.test'), 'utf8')));

    // package.json: the blank app's — its name, every @bespokecore/* at this package's version, pnpm pinned.
    const expected = JSON.parse(readFileSync(join(blank, 'package.json'), 'utf8')) as Record<string, any>;
    const written = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, any>;
    const { name: _name, description: _description, dependencies, devDependencies, ...rest } = expected;
    const pinned = (list: Record<string, string>) => Object.fromEntries(Object.entries(list).map(([name, range]) => [name, name.startsWith('@bespokecore/') ? ownVersion : range]));
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

  it('pins every @bespokecore/* to its own version; with --npm nothing of pnpm\'s', async () => {
    const cwd = workspace();
    expect((await create(cwd, ['with-npm', '--npm', '--no-install', '--no-git'])).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, 'with-npm/package.json'), 'utf8')) as Record<string, any>;
    expect(manifest.packageManager).toBeUndefined();
    expect(existsSync(join(cwd, 'with-npm/pnpm-workspace.yaml'))).toBe(false);
    const framework = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) => name.startsWith('@bespokecore/'));
    expect(framework.length).toBeGreaterThan(15);
    expect(framework.filter(([, range]) => range !== ownVersion)).toEqual([]);
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
    const run = await create(cwd, ['kit', '--private-registration', '--docker', '--no-install', '--no-git']);
    expect(run.code).toBe(0);
    for (const file of ['modules/home/index.ts', 'modules/home/routes.ts', 'modules/home/views/Home.tsx', 'modules/home/home.test.ts']) expect(existsSync(join(cwd, 'kit', file)), file).toBe(true);
    const app = readFileSync(join(cwd, 'kit/bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import home from '#modules/home';\nimport system from '#modules/system';");
    expect(app).toContain('modules: [home, system]');
    expect(run.out).toContain('pnpm install\n  pnpm exec bespoke make:auth --private-registration\n  pnpm exec bespoke migrate\n  pnpm exec bespoke make:docker');
    expect(readFileSync(join(cwd, 'kit/README.md'), 'utf8')).toContain('private: one answer for new and known addresses');
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

describe('create-bespoke-app — the framework from tarballs (BESPOKE_CREATE_TARBALLS, maintainers)', () => {
  /** A tarball as pnpm pack names it, holding `package/package.json`. */
  function tarball(dir: string, short: string, dependencies: Record<string, string> = {}): void {
    const source = join(dir, 'src', short, 'package');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: `@bespokecore/${short}`, version: '0.0.0', dependencies }));
    expect(spawnSync('tar', ['-czf', join(dir, `bespokecore-${short}-0.0.0.tgz`), '-C', join(dir, 'src', short), 'package']).status).toBe(0);
  }

  it('vendors them into the app; npm overrides what gets installed by relative path, the optional peers nobody installs by absolute path', async () => {
    const cwd = workspace();
    const tarballs = join(cwd, 'tarballs');
    mkdirSync(tarballs);
    const template = JSON.parse(readFileSync(join(TEMPLATE, 'base/_package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of [...Object.keys(template.dependencies), ...Object.keys(template.devDependencies)].filter((dependency) => dependency.startsWith('@bespokecore/'))) {
      tarball(tarballs, name.slice('@bespokecore/'.length), name === '@bespokecore/cli' ? { '@bespokecore/encryption': '0.0.0' } : {});
    }
    tarball(tarballs, 'encryption');
    tarball(tarballs, 'redis');
    expect(readTarEntry(join(tarballs, 'bespokecore-cli-0.0.0.tgz'), 'package/package.json')).toContain('"@bespokecore/encryption"');

    expect((await create(cwd, ['vendored', '--npm', '--minimal', '--no-install', '--no-git'], { env: { BESPOKE_CREATE_TARBALLS: tarballs } })).code).toBe(0);
    const app = join(cwd, 'vendored');
    expect(existsSync(join(app, 'vendor/bespokecore/bespokecore-redis-0.0.0.tgz'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(manifest.dependencies!['@bespokecore/core']).toBe('file:./vendor/bespokecore/bespokecore-core-0.0.0.tgz');
    expect(manifest.overrides!['@bespokecore/core']).toBe('file:./vendor/bespokecore/bespokecore-core-0.0.0.tgz');
    expect(manifest.overrides!['@bespokecore/encryption']).toBe('file:./vendor/bespokecore/bespokecore-encryption-0.0.0.tgz'); // cli's dependency
    expect(manifest.overrides!['@bespokecore/redis']).toBe(`file:${join(app, 'vendor/bespokecore/bespokecore-redis-0.0.0.tgz')}`); // nobody installs it

    expect((await create(cwd, ['vendored-pnpm', '--minimal', '--no-install', '--no-git'], { env: { BESPOKE_CREATE_TARBALLS: tarballs } })).code).toBe(0);
    const workspaceFile = readFileSync(join(cwd, 'vendored-pnpm/pnpm-workspace.yaml'), 'utf8');
    expect(workspaceFile).toContain('"@bespokecore/redis": "file:./vendor/bespokecore/bespokecore-redis-0.0.0.tgz"');
    expect(workspaceFile).toContain('hoistPattern: []');
  });

  it('turns a template manifest into the app\'s without touching anything but the framework', () => {
    const manifest = appManifest(JSON.stringify({ name: 'x', version: '0.0.0', description: 'gone', dependencies: { '@bespokecore/core': 'workspace:*', react: '^19' } }), {
      name: 'mine',
      packageManager: 'pnpm',
      source: { version: '1.2.3' },
    });
    expect(manifest).toEqual({ name: 'mine', version: '0.0.0', packageManager: `pnpm@${PNPM_VERSION}`, dependencies: { '@bespokecore/core': '1.2.3', react: '^19' } });
  });
});

/**
 * The starter kit as a user gets it (E150): the template and the home module, then the app's own `make:auth` and `migrate` —
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
    const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
      const result = spawnSync(command, args, { cwd: root, env: { ...base, ...extra }, encoding: 'utf8', timeout: 240_000 });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };
    // As the scaffolder runs them after the install: NODE_ENV from the app's .env (development).
    const bespoke = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/bespoke.js'), ...args], {}, sqliteEnv);
    expect(bespoke('make:auth')).toMatchObject({ code: 0, out: expect.stringContaining('Wrote bootstrap/routes.ts') });
    expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'home': { method: 'get'; path: '/'; controller: typeof ShowHomeController };");
    expect(bespoke('migrate')).toMatchObject({ code: 0, out: expect.stringContaining('Environment: development (from .env)') });
    const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
    expect(typecheck.out).toBe('');
    expect(typecheck.code).toBe(0);
    expect(run(join(root, 'node_modules/.bin/oxlint'), ['--deny-warnings'])).toMatchObject({ code: 0 });
    const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native', '--reporter=verbose'], { NODE_OPTIONS: '--conditions=@bespokecore/source', NODE_ENV: 'test' });
    expect(tests.out).toContain('modules/home/home.test.ts');
    expect(tests.out).toMatch(/Tests\s+\d+ passed \(\d+\)/);
    expect(tests.out).not.toMatch(/Tests\s+\d+ failed/);
    expect(tests.code).toBe(0);
  },
  300_000,
);
