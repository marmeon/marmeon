/**
 * `pnpm template:sync` — the blank app becomes the template of `create-marmeon`: its files (tracked and new, never ignored ones
 * like `.env`) go to `packages/create-marmeon/template/base/`, with the differences CONTRIBUTING.md names ("The starter's
 * template": `_gitignore` and `_package.json`, a standalone tsconfig, no README, every `APP_KEY=` empty).
 *
 *   pnpm template:sync                          # write the template
 *   node scripts/sync-template.ts --check       # exit 1 and name every file that differs (packages/create-marmeon tests it too)
 *
 * The starter kit's own files (`template/kit/`) are not synced.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BLANK_APP = 'apps/blank-app';
const TEMPLATE = 'packages/create-marmeon/template/base';
/** Files of the blank app the template does not take as they are. */
const OWN = new Set(['README.md', 'tsconfig.json']);
/** Names a file is stored under in the template (create-marmeon's `RENAMED` turns them back). */
const STORED: Readonly<Record<string, string>> = { '.gitignore': '_gitignore', 'package.json': '_package.json' };

/** Parses JSON with comments and trailing commas (tsconfig files). */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const string = end.exec(text)![0];
      out += string;
      i += string.length - 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The blank app's tsconfig without the monorepo: the shared settings (minus the source condition and declarations) and its own. */
export function standaloneTsconfig(repository: string = root): string {
  const base = parseJsonc(readFileSync(join(repository, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
  const app = parseJsonc(readFileSync(join(repository, BLANK_APP, 'tsconfig.json'), 'utf8')) as { compilerOptions?: Record<string, unknown>; include?: string[] };
  const { customConditions: _conditions, declaration: _d, declarationMap: _dm, sourceMap: _sm, ...shared } = base.compilerOptions;
  return `${JSON.stringify({ compilerOptions: { ...shared, ...app.compilerOptions }, include: app.include }, null, 2)}\n`;
}

/** The template's files as they should be: path inside `template/base` → contents. */
export function expectedTemplate(repository: string = root): Map<string, Buffer> {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', BLANK_APP], { cwd: repository, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = new Map<string, Buffer>();
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const source = join(repository, file);
    const path = relative(join(repository, BLANK_APP), source).split(sep).join('/');
    if (!existsSync(source) || OWN.has(path)) continue;
    const stored = STORED[basename(path)];
    const name = stored ? `${path.slice(0, -basename(path).length)}${stored}` : path;
    const contents = readFileSync(source);
    files.set(name, basename(path).startsWith('.env') ? Buffer.from(contents.toString('utf8').replace(/^APP_KEY=.*$/gm, 'APP_KEY=')) : contents);
  }
  files.set('tsconfig.json', Buffer.from(standaloneTsconfig(repository)));
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/** What differs between the template and the blank app: `missing`, `extra` or `differs`, each with its path. */
export function templateDrift(repository: string = root): string[] {
  const expected = expectedTemplate(repository);
  const dir = join(repository, TEMPLATE);
  const actual = new Set(filesUnder(dir));
  const drift: string[] = [];
  for (const [file, contents] of expected) {
    if (!actual.has(file)) drift.push(`missing ${file}`);
    else if (!readFileSync(join(dir, file)).equals(contents)) drift.push(`differs ${file}`);
  }
  for (const file of actual) if (!expected.has(file)) drift.push(`extra ${file}`);
  return drift.sort();
}

if (import.meta.main) {
  const drift = templateDrift();
  if (process.argv.includes('--check')) {
    if (drift.length > 0) {
      console.error(`template: ${TEMPLATE} is not the blank app — run pnpm template:sync:\n  ${drift.join('\n  ')}`);
      process.exitCode = 1;
    } else console.log(`template: ${TEMPLATE} is the blank app.`);
  } else {
    const dir = join(root, TEMPLATE);
    const expected = expectedTemplate();
    for (const file of filesUnder(dir)) if (!expected.has(file)) rmSync(join(dir, file));
    for (const [file, contents] of expected) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), contents);
    }
    console.log(drift.length > 0 ? `template: wrote ${TEMPLATE} (${drift.length} change${drift.length === 1 ? '' : 's'}: ${drift.join(', ')})` : `template: ${TEMPLATE} is the blank app.`);
  }
}
