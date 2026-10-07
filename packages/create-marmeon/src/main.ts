/**
 * `create-marmeon <dir>` (E150, E151, E167) — a thin shell: the template (the blank app) into a new directory, its
 * `package.json` at this package's version, `.env` with a fresh `APP_KEY`, the install — then the app's own generators: the
 * starter kit is `marmeon make:auth` plus the home module, `--docker` is `marmeon make:docker`; `marmeon migrate`, a first
 * commit. No dependencies: prompts over `node:readline`, only when a terminal asks — without one nothing is asked, and a
 * missing directory ends with exit 2.
 *
 *   pnpm create marmeon my-app                # asks (starter kit? Docker? pnpm or npm? git?) on a terminal
 *   pnpm create marmeon my-app --yes          # the defaults: starter kit, pnpm, install, git
 *   npm init marmeon my-app -- --minimal --npm --docker --no-git --no-install
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, styleText } from 'node:util';
import {
  appManifest,
  copyTemplate,
  ownVersion,
  packageName,
  installedClosure,
  pnpmWorkspace,
  readme,
  registerModule,
  titleOf,
  vendorTarballs,
  writeEnv,
  writeTitle,
  type FrameworkSource,
  type PackageManager,
} from './template.ts';

/** Exit code of a wrong call (a missing directory without a terminal, an unknown flag) — like `create-nuxt` (E167). */
export const USAGE = 2;

/** The streams and surroundings of a run — the process's by default, others in tests. */
export interface Io {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
}

const USAGE_TEXT = `Usage: create-marmeon <dir> [options]

  pnpm create marmeon my-app            asks on a terminal; --yes takes the defaults
  npm init marmeon my-app -- --npm      flags after -- with npm

Options:
  -y, --yes                 the defaults, nothing asked: the starter kit, pnpm, install, git
      --minimal             a blank app — no auth module, no home page (the starter kit is the default)
      --docker              a Dockerfile, .dockerignore and compose.production.yaml (marmeon make:docker)
      --npm | --pnpm        the package manager (pnpm by default)
      --no-install          only the files: install and run the generators yourself (the next steps say how)
      --no-git              no git repository
  -h, --help                this help
  -v, --version             the version (every @marmeon/* package and marmeon get it)
`;

export const NO_DIRECTORY = 'create-marmeon needs a directory: create-marmeon <dir> [--yes]';

/** What `--private-registration` says since it is gone (E193) — the app is made all the same. */
export const PRIVATE_REGISTRATION_FLAG_GONE =
  'create-marmeon: --private-registration is gone — the starter kit\'s registration is private by default now (it never tells ' +
  'whether an address has an account). Set AUTH_PRIVATE_REGISTRATION=false in the app\'s .env to turn it off.';

interface Choices {
  readonly directory: string;
  readonly kit: boolean;
  readonly docker: boolean;
  readonly packageManager: PackageManager;
  readonly install: boolean;
  readonly git: boolean;
}

function processIo(): Io {
  return { argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
}

export async function main(io: Io = processIo()): Promise<number> {
  const out = (text = '') => io.stdout.write(`${text}\n`);
  const err = (text: string) => io.stderr.write(`${text}\n`);
  const paint = (format: Parameters<typeof styleText>[0], text: string) => (io.stdout.isTTY ? styleText(format, text, { validateStream: false }) : text);

  let parsed;
  try {
    parsed = parseArgs({
      args: [...io.argv],
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        yes: { type: 'boolean', short: 'y' },
        minimal: { type: 'boolean' },
        // Gone (E193) — parsed only to say so.
        'private-registration': { type: 'boolean' },
        docker: { type: 'boolean' },
        npm: { type: 'boolean' },
        pnpm: { type: 'boolean' },
        install: { type: 'boolean' },
        git: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    err(`create-marmeon: ${(error as Error).message}\n\n${USAGE_TEXT}`);
    return USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE_TEXT);
    return 0;
  }
  if (values.version) {
    out(ownVersion());
    return 0;
  }
  if (positionals.length > 1) {
    err(`create-marmeon takes one directory, not ${positionals.length}: ${positionals.join(' ')}\n\n${USAGE_TEXT}`);
    return USAGE;
  }
  if (values.npm && values.pnpm) {
    err('create-marmeon: choose one package manager — --npm or --pnpm.');
    return USAGE;
  }
  if (values['private-registration'] !== undefined) err(PRIVATE_REGISTRATION_FLAG_GONE);

  // Asked only on a terminal, and never with --yes: without one a run never waits for an answer (E167).
  const interactive = io.stdin.isTTY === true && io.stdout.isTTY === true;
  let choices: Choices | undefined;
  try {
    choices = await choose(values, positionals[0], interactive && values.yes !== true, interactive, io);
  } catch (error) {
    if ((error as { code?: string }).code === 'ABORT_ERR') {
      err('\ncreate-marmeon: cancelled.');
      return 130;
    }
    throw error;
  }
  if (!choices) {
    err(NO_DIRECTORY);
    return USAGE;
  }

  const target = resolve(io.cwd, choices.directory);
  if (existsSync(target) && readdirSync(target).length > 0) {
    err(`create-marmeon: ${choices.directory} is not empty — choose a new directory.`);
    return 1;
  }
  const name = packageName(basename(target));
  const title = titleOf(name);
  const pm = choices.packageManager;
  const tarballs = io.env.MARMEON_CREATE_TARBALLS;
  const env = commandEnvironment(io.env);

  if (choices.install && !available(pm, env)) {
    err(`create-marmeon: ${pm} is not installed${pm === 'pnpm' ? ` — install it (npm install --global pnpm@12) or pass --npm` : ''}.`);
    return 1;
  }

  const shown = relative(io.cwd, target) || '.';
  out(`Creating ${paint('bold', name)} in ${shown} — ${choices.kit ? 'the starter kit' : 'a blank app'}${choices.docker ? ', Docker files' : ''}, ${pm}`);
  const step = (text: string) => out(`  ${paint('green', '✓')} ${text}`);
  const fail = (text: string, output?: string) => {
    err(`  ${paint('red', '✗')} ${text}`);
    if (output?.trim()) err(output.trimEnd().replace(/^/gm, '    '));
    err(`create-marmeon: ${shown} is left as it is — fix the cause and run the step yourself, or remove the directory and start again.`);
    return 1;
  };

  // 1 · The files.
  mkdirSync(target, { recursive: true });
  copyTemplate('base', target);
  if (choices.kit) {
    copyTemplate('kit', target);
    registerModule(target, 'home');
  }
  let source: FrameworkSource = { version: ownVersion() };
  if (tarballs) {
    // For the framework's maintainers (pack:smoke, image): the packages from `pnpm pack` instead of the registry (README).
    const vendored = vendorTarballs(resolve(io.cwd, tarballs), target);
    if (vendored.size === 0) return fail(`MARMEON_CREATE_TARBALLS=${tarballs} has no framework tarballs (marmeon-*.tgz).`);
    source = { tarballs: vendored, app: target };
  }
  const template = readFileSync(join(target, 'package.json'), 'utf8');
  if ('tarballs' in source && pm === 'pnpm') writeFileSync(join(target, 'pnpm-workspace.yaml'), pnpmWorkspace(source.tarballs, installedClosure(JSON.parse(template), source)));
  const manifest = appManifest(template, { name, packageManager: pm, source });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeEnv(target, title);
  writeTitle(target, title);
  writeFileSync(join(target, 'README.md'), readme({ name, title, packageManager: pm, kit: choices.kit, docker: choices.docker }));
  step(`the files${choices.kit ? ' (with the home module)' : ''}, package.json${'version' in source ? ` (@marmeon/* and marmeon ${source.version})` : ' (the framework from MARMEON_CREATE_TARBALLS)'}, .env with a new APP_KEY`);

  // 2 · Install, then the app's own generators (they come with marmeon).
  const generators: string[][] = [
    ...(choices.kit ? [['make:auth']] : []),
    // .env says NODE_ENV=development: no --force, and it writes bootstrap/database.d.ts (the tables' types the build checks).
    ['migrate'],
    ...(choices.docker ? [['make:docker']] : []),
  ];
  const pending: string[] = [];
  if (choices.install) {
    out(`  … ${pm} install`);
    const started = performance.now();
    const install = spawnSync(pm, pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'], { cwd: target, env, stdio: ['ignore', 'inherit', 'inherit'] });
    if (install.status !== 0) return fail(`${pm} install failed (exit ${install.status ?? install.signal})`);
    step(`${pm} install (${((performance.now() - started) / 1000).toFixed(1)}s)`);
    const marmeon = join(target, 'node_modules', '.bin', 'marmeon');
    for (const args of generators) {
      const result = spawnSync(marmeon, args, { cwd: target, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) return fail(`marmeon ${args.join(' ')} failed (exit ${result.status ?? result.signal})`, output(result));
      step(`marmeon ${args.join(' ')}`);
    }
  } else {
    pending.push(`${pm} install`, ...generators.map((args) => `${pm === 'pnpm' ? 'pnpm exec marmeon' : 'npx marmeon'} ${args.join(' ')}`));
  }

  // 3 · git: a repository with a first commit — unless the directory is inside one already. Signing is the user's git config:
  // when it fails (a key that is not there), the files stay staged and the run says so.
  if (choices.git) {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: target, env: io.env, encoding: 'utf8' });
    if (git('--version').error) out(`  ${paint('yellow', '!')} git is not installed — no repository`);
    else if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() === 'true') out(`  ${paint('yellow', '!')} ${shown} is inside a git repository already — no new one`);
    else {
      const init = git('init', '--quiet');
      const add = init.status === 0 ? git('add', '--all') : init;
      if (add.status !== 0) return fail('git init failed', output(add));
      const commit = git('commit', '--quiet', '--message', 'Create the app with create-marmeon');
      if (commit.status === 0) step('git: a repository with the first commit');
      else {
        err(`  ${paint('yellow', '!')} git commit failed — the repository is there and every file is staged; commit yourself (git commit).`);
        err(output(commit).trimEnd().replace(/^/gm, '    '));
      }
    }
  }

  out();
  out(`${paint('bold', 'Done.')} Next:`);
  if (shown !== '.') out(`  cd ${shown}`);
  for (const command of pending) out(`  ${command}`);
  out(`  ${pm === 'pnpm' ? 'pnpm dev' : 'npm run dev'}${' '.repeat(pm === 'pnpm' ? 12 : 9)}# http://localhost:3000 — ${choices.kit ? 'register, and the confirmation link is in the log (MAIL_MAILER=log)' : 'add modules: marmeon make:module <name>'}`);
  out(`  ${pm === 'pnpm' ? 'pnpm test' : 'npm test'}${' '.repeat(pm === 'pnpm' ? 11 : 12)}# Vitest`);
  return 0;
}

/**
 * The choices: flags first, then — on a terminal, without --yes — questions for the rest. A missing directory is asked on a
 * terminal (with --yes too: it has no default); without one the result is undefined, and the run ends with exit 2.
 */
async function choose(values: Record<string, boolean | undefined>, directory: string | undefined, ask: boolean, terminal: boolean, io: Io): Promise<Choices | undefined> {
  if (directory === undefined && !terminal) return undefined;
  const questions = ask || directory === undefined ? createInterface({ input: io.stdin, output: io.stdout }) : undefined;
  try {
    const question = async (text: string, fallback: string) => (await questions!.question(`${text} `)).trim() || fallback;
    const yesNo = async (text: string, fallback: boolean) => (await question(`${text} (${fallback ? 'Y/n' : 'y/N'})`, fallback ? 'y' : 'n')).toLowerCase().startsWith('y');
    const dir = directory ?? (await question('Directory of the new app (my-app):', 'my-app'));
    const kit = values.minimal === true ? false : !ask ? true : await yesNo('The starter kit — sign-in and registration, a layout, a home page?', true);
    const docker = values.docker ?? (ask ? await yesNo('Docker files (Dockerfile, compose.production.yaml)?', false) : false);
    const packageManager: PackageManager =
      values.npm === true ? 'npm' : values.pnpm === true || !ask ? 'pnpm' : (await question('Package manager — pnpm or npm (pnpm):', 'pnpm')).toLowerCase().startsWith('n') ? 'npm' : 'pnpm';
    const git = values.git ?? (ask ? await yesNo('A git repository with a first commit?', true) : true);
    return { directory: dir, kit, docker, packageManager, install: values.install !== false, git };
  } finally {
    questions?.close();
  }
}

/**
 * The environment of `install` and the generators: the user's, without `NODE_ENV` — the app's `.env` says `development` (E170),
 * so `migrate` needs no `--force` and writes the tables' types even in a shell that exports `NODE_ENV=production`.
 */
function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_ENV: _env, MARMEON_CREATE_TARBALLS: _tarballs, ...rest } = env;
  return rest;
}

function available(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ['--version'], { env, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
}
