/**
 * The files of a new app (E150, E167): the template (`template/base` = the blank app, `template/kit` = what the starter kit
 * adds besides the auth module), the app's `package.json`, its `.env` with a fresh `APP_KEY`, its README. No dependencies —
 * everything here is Node's own.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** `template/` of this package: `base/` (the blank app — `pnpm template:sync` copies it) and `kit/` (the starter kit's own files). */
export const TEMPLATE = fileURLToPath(new URL('../template/', import.meta.url));

/** The pnpm a new app pins (`packageManager`, E151) — the one the framework is tested with (a test keeps it equal to the repository's). */
export const PNPM_VERSION = '12.9.0';

/**
 * Files a published tarball must not carry under their own name: npm turns `.gitignore` into `.npmignore` when it packs, and a
 * nested `package.json` confuses tools (publint, bundlers). The template keeps them as `_gitignore` and `_package.json`; a new
 * app gets them back under their names.
 */
export const RENAMED: Readonly<Record<string, string>> = { _gitignore: '.gitignore', '_package.json': 'package.json' };

export type PackageManager = 'pnpm' | 'npm';

/** This package's own version — every `@bespokecore/*` of a new app gets exactly this one (lockstep, E167). */
export function ownVersion(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

/** The files below `dir`, relative to it, with forward slashes, sorted. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** The name a template file gets in the app (`storage/_gitignore` → `storage/.gitignore`). */
export function appPath(file: string): string {
  const name = basename(file);
  const renamed = RENAMED[name];
  return renamed ? `${file.slice(0, file.length - name.length)}${renamed}` : file;
}

/** Copies `template/<part>` into the app; returns the app's paths of the copied files. */
export function copyTemplate(part: 'base' | 'kit', target: string, template = TEMPLATE): string[] {
  const source = join(template, part);
  const copied: string[] = [];
  for (const file of filesUnder(source)) {
    const destination = join(target, appPath(file));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, file), destination);
    copied.push(appPath(file));
  }
  return copied;
}

/**
 * A valid npm package name from a directory name: lower case, letters, digits, `-`, `.` and `_`, never starting with `.` or
 * `_` (`My App` → `my-app`).
 */
export function packageName(directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[-]+$/g, '');
  return name === '' ? 'bespoke-app' : name.slice(0, 214);
}

/** The app's name for people (`APP_NAME`): `my-app` → `My App`. */
export function titleOf(name: string): string {
  return name
    .split(/[-._]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/** Where the framework comes from: the registry at this package's version, or tarballs inside the app (maintainers, see README). */
export type FrameworkSource = { readonly version: string } | { readonly tarballs: ReadonlyMap<string, string>; readonly app: string };

export interface ManifestOptions {
  readonly name: string;
  readonly packageManager: PackageManager;
  readonly source: FrameworkSource;
}

/**
 * The app's `package.json` from the template's (the blank app's): its name, every `@bespokecore/*` at exactly the version of
 * this package (or its tarball), `packageManager` for pnpm — nothing pnpm's for npm.
 */
export function appManifest(template: string, { name, packageManager, source }: ManifestOptions): Record<string, unknown> {
  const manifest = JSON.parse(template) as Record<string, any>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'description') continue;
    result[key] = key === 'name' ? name : value;
    if (key === 'version' && packageManager === 'pnpm') result.packageManager = `pnpm@${PNPM_VERSION}`;
  }
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const list = manifest[field] as Record<string, string> | undefined;
    if (!list) continue;
    result[field] = Object.fromEntries(Object.entries(list).map(([dependency, range]) => [dependency, dependency.startsWith('@bespokecore/') ? spec(dependency, source) : range]));
  }
  if ('tarballs' in source && packageManager === 'npm') {
    // npm resolves the packages' dependencies on each other through overrides (pnpm: pnpm-workspace.yaml). What gets installed
    // (the app's packages and what they depend on) by its path relative to the app, as the lockfile records it — an override of
    // a direct dependency must be its spec exactly, and a Docker build has the app's directory only. The optional peers nobody
    // installs (redis, live, …) by absolute path: npm reads their manifests to check the peer ranges, and reads a relative
    // `file:` of an override from the dependent's directory, where there is no vendor/.
    const installed = installedClosure(manifest, source);
    result.overrides = Object.fromEntries([...source.tarballs].map(([dependency, file]) => [dependency, installed.has(dependency) ? `file:${file}` : `file:${join(source.app, file)}`]));
  }
  return result;
}

/** The framework packages an install of `manifest` puts into node_modules: its own and, transitively, their `dependencies`. */
function installedClosure(manifest: Record<string, any>, source: { tarballs: ReadonlyMap<string, string>; app: string }): Set<string> {
  const pending = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].filter((name) => name.startsWith('@bespokecore/'));
  const installed = new Set<string>();
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const file = source.tarballs.get(name);
    if (installed.has(name) || !file) continue;
    installed.add(name);
    const packed = JSON.parse(readTarEntry(join(source.app, file), 'package/package.json')) as { dependencies?: Record<string, string> };
    pending.push(...Object.keys(packed.dependencies ?? {}).filter((dependency) => dependency.startsWith('@bespokecore/')));
  }
  return installed;
}

/** One file of a `.tgz` (gzip, then tar: 512-byte headers, the size in octal) — Node's zlib, no tar package. */
export function readTarEntry(tarball: string, path: string): string {
  const tar = gunzipSync(readFileSync(tarball));
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (name === '') break;
    const size = Number.parseInt(tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === path) return tar.toString('utf8', offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${path} is not in ${tarball}.`);
}

function spec(dependency: string, source: FrameworkSource): string {
  if ('version' in source) return source.version;
  const file = source.tarballs.get(dependency);
  if (!file) throw new Error(`No tarball for ${dependency} in BESPOKE_CREATE_TARBALLS.`);
  return `file:${file}`;
}

/** pnpm's settings for the tarball source: the packages' dependencies on each other from the tarballs, and nothing hoisted. */
export function pnpmWorkspace(tarballs: ReadonlyMap<string, string>): string {
  return [
    '# Written by create-bespoke-app (BESPOKE_CREATE_TARBALLS): the framework from its tarballs.',
    'overrides:',
    ...[...tarballs].map(([dependency, file]) => `  ${JSON.stringify(dependency)}: ${JSON.stringify(`file:${file}`)}`),
    '# Nothing hoisted: a package can only import what it declares.',
    'hoistPattern: []',
    '',
  ].join('\n');
}

/**
 * The framework's tarballs in `dir` (`pnpm pack` names them `bespokecore-<short>-<version>.tgz`), copied into the app under
 * `vendor/bespokecore/` — a Docker build context sees them there. Returns package name → path relative to the app.
 */
export function vendorTarballs(dir: string, app: string): Map<string, string> {
  const tarballs = new Map<string, string>();
  const vendor = join(app, 'vendor', 'bespokecore');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort()) {
    const match = /^bespokecore-(.+)-\d+\.\d+\.\d+(?:-[\w.]+)?\.tgz$/.exec(file);
    if (!match) continue;
    mkdirSync(vendor, { recursive: true });
    copyFileSync(join(dir, file), join(vendor, file));
    tarballs.set(`@bespokecore/${match[1]}`, `./vendor/bespokecore/${file}`);
  }
  return tarballs;
}

/** `APP_KEY` as `bespoke key:generate` writes it: `base64:` and 32 random bytes. */
export function generateKey(): string {
  return `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`;
}

/** A `.env` value, quoted when it has to be. */
function envValue(value: string): string {
  return /^[\w.:/@+=-]*$/.test(value) ? value : JSON.stringify(value);
}

/** Sets `KEY=value` in a `.env` text — the line must be there (the template's files have every key a new app sets). */
export function setEnv(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (!line.test(text)) throw new Error(`${key}= is missing — the template changed?`);
  return text.replace(line, () => `${key}=${envValue(value)}`);
}

/**
 * The app's name into `.env.example` and `.env.test`, and `.env` from `.env.example` with a fresh `APP_KEY` — never in the
 * template, never in `.env.example`. `.env` is readable by its owner only (git ignores it). `.env.test` gets a key of its own:
 * committed, for the tests only — no two apps share one.
 */
export function writeEnv(app: string, title: string): void {
  const example = setEnv(readFileSync(join(app, '.env.example'), 'utf8'), 'APP_NAME', title);
  writeFileSync(join(app, '.env.example'), example);
  const test = join(app, '.env.test');
  if (existsSync(test)) writeFileSync(test, setEnv(setEnv(readFileSync(test, 'utf8'), 'APP_NAME', `${title} (test)`), 'APP_KEY', generateKey()));
  writeFileSync(join(app, '.env'), setEnv(example, 'APP_KEY', generateKey()), { mode: 0o600 });
}

/** Adds a module to `modules: [...]` of `bootstrap/app.ts`, imported next to `system` (the blank app has exactly that). */
export function registerModule(app: string, name: string): void {
  const file = join(app, 'bootstrap', 'app.ts');
  const source = readFileSync(file, 'utf8');
  const anchor = "import system from '#modules/system';";
  if (!source.includes(anchor) || !/modules: \[system\]/.test(source)) throw new Error(`bootstrap/app.ts has no \`${anchor}\` and \`modules: [system]\` — the template changed?`);
  writeFileSync(file, source.replace(anchor, `import ${name} from '#modules/${name}';\n${anchor}`).replace('modules: [system]', `modules: [${name}, system]`));
}

export interface ReadmeOptions {
  readonly name: string;
  readonly title: string;
  readonly packageManager: PackageManager;
  readonly kit: boolean;
  readonly privateRegistration: boolean;
  readonly docker: boolean;
}

/** The app's README: what it is, the commands, where things are. */
export function readme({ title, packageManager, kit, privateRegistration, docker }: ReadmeOptions): string {
  const run = (script: string) => (packageManager === 'pnpm' ? `pnpm ${script}` : script === 'test' ? 'npm test' : `npm run ${script}`);
  const exec = packageManager === 'pnpm' ? 'pnpm exec bespoke' : 'npx bespoke';
  const lines = [
    `# ${title}`,
    '',
    `A [BespokeCore](https://github.com/bespokecore/bespokecore) app, created with \`create-bespoke-app\`${kit ? ' — the starter kit' : ''}.`,
    '',
    '```sh',
    `${run('dev').padEnd(26)}# the server with Vite, a queue worker and the scheduler: http://localhost:3000`,
    `${run('test').padEnd(26)}# the tests (Vitest): modules/**/*.test.ts`,
    `${run('lint').padEnd(26)}# oxlint with the app's preset (.oxlintrc.json)`,
    `${run('build').padEnd(26)}# type-check, client and SSR build`,
    `${run('start').padEnd(26)}# the build, as production runs it (set NODE_ENV and the configuration in the real environment)`,
    `${`${exec} migrate`.padEnd(26)}# after a new migration — .env says NODE_ENV=development: it writes bootstrap/database.d.ts`,
    `${exec} queue:work --queue=mail,default  # production: a worker for the queued jobs and the auth module's mails (bespoke dev runs one)`,
    '```',
    '',
    '`.env` holds this machine\'s configuration and the application key (`APP_KEY`) — it is not committed. `.env.example` lists',
    'every setting; `.env.test` is what the tests run with.',
    '',
    '## Where things are',
    '',
    '```text',
    'bootstrap/app.ts        the application: its modules, config and global middleware (CSP with a nonce per response)',
    'modules/<name>/         a feature: routes, controllers, views, migrations, tests — `bespoke make:module <name>`',
    ...(kit
      ? [
          `modules/auth/           sign-in, registration${privateRegistration ? ' (private: one answer for new and known addresses)' : ''}, password reset, e-mail verification, API tokens`,
          '                        — generated by `bespoke make:auth`, yours to change; its layout is modules/auth/layouts/AppLayout.tsx',
          'modules/home/           the home page (/)',
        ]
      : []),
    'modules/system/         the framework drivers\' tables (the queue\'s jobs) — `bespoke make:*-table` writes there',
    'middleware/             SecurityHeaders (nosniff, referrer policy, frame options, an HSTS switch)',
    'config/app.ts           APP_NAME, APP_URL',
    'storage/                the SQLite database, sessions, cache, uploads (git keeps the folders only)',
    ...(docker ? ['Dockerfile              `bespoke make:docker`: the image; compose.production.yaml runs web, worker and scheduler'] : []),
    '```',
    '',
    `Development tools — the error page, the devtools at \`/_bespoke/devtools\` and the in-page bar — run with \`NODE_ENV=development\``,
    `only (\`${run('dev')}\`). The framework's guides: https://github.com/bespokecore/bespokecore#readme${docker ? ' — deployment:' : ''}`,
    ...(docker ? ['https://github.com/bespokecore/bespokecore/blob/main/docs/deployment.md'] : []),
    '',
  ];
  return lines.join('\n');
}
