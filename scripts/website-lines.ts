/**
 * `node scripts/website-lines.ts add <tag> | verify` — the documentation of each release line the website serves under `/docs/<line>/`
 * (`0.4.x` before 1.0, `<major>.x` after), pinned to the commit of a release tag.
 *
 *   apps/website/docs-lines.json            { "format": 1, "lines": { "0.3.x": { "version", "tag", "commit" } } } — the pins, reviewed in a pull request
 *   apps/website/content/lines/<line>/      the snapshot: docs/*.md, UPGRADING.md, SECURITY.md, CONTRIBUTING.md byte for byte from the
 *                                           commit, and docs/index.json (format 1, as `node_modules/marmeon/docs/index.json`)
 *
 * Only `add` writes either. Docs are read as an agent's instructions, so the tool trusts nothing a tag names: it reads Git objects
 * (`ls-tree`, `cat-file`), never unpacks an archive and never runs code from the commit — the navigation (`docs.config.ts`) is read
 * as text, literals only. `add` refuses a tag that is not an annotated `v<x.y.z>`, one that differs from the remote's, a commit that
 * is neither on `main` nor on the line's branch, a manifest of another version, and a tree with anything but regular `[a-z0-9-]+.md`
 * pages. `verify` (part of `pnpm website:check`) holds snapshot and remote tag to the pin in every run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocsDefinition } from '../apps/website/docs.config.ts';
import { docsIndex, ROOT_FILES } from './docs-ship.ts';
import { oxc } from './source-files.ts';

/** The pins, relative to the repository. */
export const PINS_FILE = 'apps/website/docs-lines.json';
/** The snapshots, one directory per line, relative to the repository. */
export const LINES_DIR = 'apps/website/content/lines';

const TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const LINE = /^(?:0\.(?:0|[1-9]\d*)\.x|[1-9]\d*\.x)$/;
/** The files a snapshot may hold; every path written is checked against it. */
const SNAPSHOT_PATH = /^(?:docs\/[a-z0-9-]+\.(?:md|json)|UPGRADING\.md|SECURITY\.md|CONTRIBUTING\.md)$/;
const NAVIGATION = 'apps/website/docs.config.ts';
const MANIFESTS = ['packages/core/package.json', 'packages/cli/package.json'] as const;

/** What the tool asks Git; injectable, so a test can make Git fail. */
export interface Git {
  /** stdout as text; throws with Git's message when the command fails. */
  capture(args: readonly string[]): string;
  /** stdout as bytes. */
  bytes(args: readonly string[]): Buffer;
  /** Whether the command exits with 0 (any other status, or no Git, is `false`). */
  succeeds(args: readonly string[]): boolean;
}

/** Git in `cwd` — arguments as an array, never through a shell. */
export function gitIn(cwd: string): Git {
  const run = (args: readonly string[]) =>
    execFileSync('git', [...args], {
      cwd,
      maxBuffer: 512 * 1024 * 1024,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // No replace refs: a ref in the checkout must not swap the objects the snapshot is read from.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
  const failure = (args: readonly string[], error: unknown): Error => {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim();
    return new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  };
  return {
    capture(args) {
      try {
        return run(args).toString('utf8');
      } catch (error) {
        throw failure(args, error);
      }
    },
    bytes(args) {
      try {
        return run(args);
      } catch (error) {
        throw failure(args, error);
      }
    },
    succeeds(args) {
      try {
        run(args);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The line a version belongs to: `0.<minor>.x` before 1.0, `<major>.x` after; none for a pre-release or anything else. */
export function lineOf(version: string): string | undefined {
  const zero = /^0\.(\d+)\.\d+$/.exec(version);
  if (zero) return `0.${zero[1]}.x`;
  const major = /^([1-9]\d*)\.\d+\.\d+$/.exec(version);
  return major ? `${major[1]}.x` : undefined;
}

export interface LinePin {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
}

/** The pins of `root`; none without the file. Throws on anything the format does not allow. */
export function readPins(root: string): Record<string, LinePin> {
  const file = join(root, PINS_FILE);
  if (!existsSync(file)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${PINS_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(data) || !sameKeys(data, ['format', 'lines'])) throw new Error(`${PINS_FILE} has to be { "format": 1, "lines": {…} } and nothing else`);
  if (data.format !== 1) throw new Error(`${PINS_FILE}: format ${JSON.stringify(data.format)} is not 1`);
  if (!isRecord(data.lines)) throw new Error(`${PINS_FILE}: "lines" has to be an object`);
  const pins: Record<string, LinePin> = {};
  for (const [line, pin] of Object.entries(data.lines)) {
    if (!isRecord(pin) || !sameKeys(pin, ['version', 'tag', 'commit'])) throw new Error(`${PINS_FILE}: the pin of ${line} has to hold version, tag and commit and nothing else`);
    const { version, tag, commit } = pin;
    if (typeof version !== 'string' || !VERSION.test(version)) throw new Error(`${PINS_FILE}: the version of ${line} is not <major>.<minor>.<patch>`);
    if (lineOf(version) !== line) throw new Error(`${PINS_FILE}: ${version} does not belong to the line ${line}`);
    if (tag !== `v${version}`) throw new Error(`${PINS_FILE}: the tag of ${line} is not v${version}`);
    if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new Error(`${PINS_FILE}: the commit of ${line} is not 40 hexadecimal digits`);
    pins[line] = { version, tag, commit };
  }
  return pins;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, index) => key === own[index]);
}

function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (x?.[index] ?? 0) - (y?.[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The pins as the file holds them: lines by version, keys in a fixed order, `\n` at the end. */
function pinsText(pins: Record<string, LinePin>): string {
  const lines: Record<string, LinePin> = {};
  for (const [line, { version, tag, commit }] of Object.entries(pins).sort(([, a], [, b]) => compareVersions(a.version, b.version))) lines[line] = { version, tag, commit };
  return `${JSON.stringify({ format: 1, lines }, null, 2)}\n`;
}

interface Node {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

/**
 * The navigation in the text of a `docs.config.ts`: the argument of `export default defineDocs(…)`, read as a syntax tree, never
 * run. Only object, array and string literals and `true` are accepted; a call, a spread, a name or a template with an expression
 * stops with the line and the kind of node. The text comes from a tag, so nothing in it may execute.
 */
export function readDocsConfig(text: string): DocsDefinition {
  const parsed = oxc().parseSync(NAVIGATION, text);
  if (parsed.errors.length > 0) throw new Error(`${NAVIGATION} does not parse: ${parsed.errors[0]?.message}`);
  const lineAt = (node: Node) => text.slice(0, node.start).split('\n').length;
  const refuse = (node: Node, why: string): never => {
    throw new Error(`${NAVIGATION}:${lineAt(node)}: ${node.type} ${why} — only object, array and string literals and true are read`);
  };
  const body = (parsed.program as { body: Node[] }).body;
  const exported = body.filter((node) => node.type === 'ExportDefaultDeclaration');
  if (exported.length !== 1) throw new Error(`${NAVIGATION} needs exactly one export default, found ${exported.length}`);
  const declaration = (exported[0] as Node).declaration as Node;
  const callee = declaration.callee as Node | undefined;
  const args = declaration.arguments as Node[] | undefined;
  if (declaration.type !== 'CallExpression' || callee?.type !== 'Identifier' || callee.name !== 'defineDocs' || args?.length !== 1) {
    return refuse(declaration, 'is not defineDocs({…})');
  }

  const evaluate = (node: Node): unknown => {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string' || node.value === true) return node.value;
        return refuse(node, 'is a literal that is neither a string nor true');
      case 'TemplateLiteral': {
        const quasis = node.quasis as { value: { cooked: string } }[];
        if ((node.expressions as Node[]).length > 0) return refuse(node, 'has an expression');
        return quasis[0]?.value.cooked;
      }
      case 'ArrayExpression':
        return (node.elements as (Node | null)[]).map((element) => (element === null ? refuse(node, 'has a hole') : evaluate(element)));
      case 'ObjectExpression': {
        const object: Record<string, unknown> = Object.create(null);
        for (const property of node.properties as Node[]) {
          if (property.type !== 'Property') return refuse(property, 'is not a plain property');
          const key = property.key as Node;
          if (property.computed || property.shorthand || property.method || property.kind !== 'init') return refuse(property, 'is not a plain property');
          if (key.type === 'Identifier') object[key.name as string] = evaluate(property.value as Node);
          else if (key.type === 'Literal' && typeof key.value === 'string') object[key.value] = evaluate(property.value as Node);
          else return refuse(key, 'is not a name or a string');
        }
        return object;
      }
      default:
        return refuse(node, 'is not allowed');
    }
  };

  const config = evaluate((args as Node[])[0] as Node);
  const fail = (what: string): never => {
    throw new Error(`${NAVIGATION}: ${what}`);
  };
  if (!isRecord(config) || !sameKeys(config, ['sections']) || !Array.isArray(config.sections)) return fail('defineDocs needs { sections: […] }');
  const sections = (config.sections as unknown[]).map((section) => {
    if (!isRecord(section) || !sameKeys(section, ['title', 'pages']) || typeof section.title !== 'string' || !Array.isArray(section.pages)) return fail('a section needs a title and pages');
    const pages = (section.pages as unknown[]).map((entry) => {
      if (!isRecord(entry) || typeof entry.slug !== 'string' || typeof entry.label !== 'string') return fail('a page needs a slug and a label');
      const allowed = ['slug', 'label', 'file', 'changes'];
      if (Object.keys(entry).some((key) => !allowed.includes(key))) return fail(`the page ${entry.slug} has a key other than ${allowed.join(', ')}`);
      if (!/^[a-z0-9-]+$/.test(entry.slug)) return fail(`the slug ${JSON.stringify(entry.slug)} is not lower-case words with dashes`);
      if (entry.file !== undefined && typeof entry.file !== 'string') return fail(`the file of ${entry.slug} is not a string`);
      if (entry.changes !== undefined && entry.changes !== true) return fail(`changes of ${entry.slug} is not true`);
      return { slug: entry.slug, label: entry.label, ...(entry.file !== undefined ? { file: entry.file } : {}), ...(entry.changes === true ? { changes: true as const } : {}) };
    });
    return { title: section.title, pages };
  });
  return { sections };
}

/** The files of a line as the commit holds them, with the index: path relative to the line's directory → bytes. */
export function snapshotOf(git: Git, commit: string, version: string): Map<string, Buffer> {
  if (!COMMIT.test(commit)) throw new Error(`${commit} is not a commit hash`);
  const listed = git.capture(['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'docs', ...ROOT_FILES, NAVIGATION, ...MANIFESTS]);
  const blobs = new Map<string, string>();
  for (const record of listed.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`git ls-tree printed an entry this tool cannot read: ${JSON.stringify(record)}`);
    const [, mode, type, hash, path] = match as unknown as [string, string, string, string, string];
    const wanted = path.startsWith('docs/') ? /^docs\/[a-z0-9-]+\.md$/.test(path) : [...ROOT_FILES, NAVIGATION, ...MANIFESTS].includes(path as never);
    if (!wanted) throw new Error(`${path} is in the commit, but docs/ may hold regular [a-z0-9-]+.md pages only`);
    if (type !== 'blob' || mode !== '100644') throw new Error(`${path} is not a regular file (mode ${mode}, ${type}) — a symlink, an executable or a submodule would carry other bytes into the docs`);
    blobs.set(path, hash);
  }
  for (const needed of [...ROOT_FILES, NAVIGATION, ...MANIFESTS]) if (!blobs.has(needed)) throw new Error(`${needed} is missing in ${commit}`);
  const blob = (path: string) => git.bytes(['cat-file', 'blob', blobs.get(path) as string]);

  for (const manifest of MANIFESTS) {
    let found: unknown;
    try {
      found = (JSON.parse(blob(manifest).toString('utf8')) as { version?: unknown }).version;
    } catch {
      throw new Error(`${manifest} at ${commit} is not JSON`);
    }
    if (found !== version) throw new Error(`${manifest} at ${commit} says version ${JSON.stringify(found)}, expected ${version}`);
  }

  const files = new Map<string, Buffer>();
  for (const path of [...blobs.keys()].sort()) if (path.startsWith('docs/') || (ROOT_FILES as readonly string[]).includes(path)) files.set(path, blob(path));
  const index = docsIndex(readDocsConfig(blob(NAVIGATION).toString('utf8')), files, version);
  files.set('docs/index.json', Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  for (const path of files.keys()) if (!SNAPSHOT_PATH.test(path)) throw new Error(`${path} is not a path a snapshot may hold`);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface LinesOptions {
  /** The repository: where the pins and the snapshots are, and where Git runs. */
  readonly root: string;
  readonly git?: Git;
  readonly log?: (line: string) => void;
}

/** Pins `tag` and writes its line's snapshot. Throws, writing nothing, when any check fails. */
export function addLine(tag: string, options: LinesOptions): { line: string; pin: LinePin; files: number; bytes: number } {
  const { root } = options;
  const git = options.git ?? gitIn(root);
  const log = options.log ?? (() => {});
  if (!TAG.test(tag)) throw new Error(`${JSON.stringify(tag)} is not a release tag (v<major>.<minor>.<patch>, no pre-release)`);
  const version = tag.slice(1);
  const line = lineOf(version);
  if (line === undefined || !LINE.test(line)) throw new Error(`${tag} belongs to no release line`);

  if (git.capture(['cat-file', '-t', `refs/tags/${tag}`]).trim() !== 'tag') throw new Error(`${tag} is a lightweight tag — only the annotated tag of a release is pinned`);
  const commit = git.capture(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  if (!COMMIT.test(commit)) throw new Error(`${tag} does not name a commit`);

  const remote = remoteTagCommit(git, tag);
  if (remote === undefined) throw new Error(`origin has no annotated tag ${tag}`);
  if (remote !== commit) throw new Error(`the local ${tag} is ${commit}, the tag on origin is ${remote} — one of them was moved`);

  // Explicit refspecs, no tags: a fetch that took tags could overwrite the one just compared.
  git.capture(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const refs = ['refs/remotes/origin/main'];
  if (git.capture(['ls-remote', '--heads', 'origin', `refs/heads/${line}`]).trim() !== '') {
    git.capture(['fetch', '--no-tags', 'origin', `+refs/heads/${line}:refs/remotes/origin/${line}`]);
    refs.push(`refs/remotes/origin/${line}`);
  }
  if (!refs.some((ref) => git.succeeds(['merge-base', '--is-ancestor', commit, ref]))) {
    throw new Error(`${commit} is on neither origin/main nor origin/${line} — a release is pinned only from the history that was reviewed`);
  }

  const files = snapshotOf(git, commit, version);

  const pins = readPins(root);
  const existing = pins[line];
  if (existing !== undefined) {
    const order = compareVersions(version, existing.version);
    if (order < 0) throw new Error(`${line} is pinned to ${existing.version}, which is newer than ${version}`);
    if (order === 0 && existing.commit !== commit) throw new Error(`${line} is pinned to ${existing.version} at ${existing.commit}; ${tag} now names ${commit} — a pin changes with a new version only`);
  }
  const pin: LinePin = { version, tag, commit };
  pins[line] = pin;

  const linesDir = join(root, LINES_DIR);
  const target = join(linesDir, line);
  const staging = join(linesDir, `.${line}.staging`);
  rmSync(staging, { recursive: true, force: true });
  let bytes = 0;
  for (const [path, content] of files) {
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), content);
    bytes += content.length;
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  writeFileSync(join(root, PINS_FILE), pinsText(pins));

  log(`website-lines: pinned ${line} to ${tag} (${commit}): ${files.size} files, ${bytes} bytes in ${LINES_DIR}/${line}/`);
  log(`website-lines: open a pull request with ${PINS_FILE} and ${LINES_DIR}/${line}/`);
  return { line, pin, files: files.size, bytes };
}

/** The commit an annotated tag points to on origin; none when origin has no such annotated tag. */
function remoteTagCommit(git: Git, tag: string): string | undefined {
  // The pattern matches the end of a ref name too (`refs/tags/x/refs/tags/v1.0.0^{}`), so only the line of exactly this ref counts.
  const ref = `refs/tags/${tag}^{}`;
  const found: string[] = [];
  for (const line of git.capture(['ls-remote', 'origin', ref]).split('\n').filter((entry) => entry.trim() !== '')) {
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (!match) throw new Error(`git ls-remote printed something this tool cannot read: ${JSON.stringify(line)}`);
    if (match[2] === ref) found.push(match[1] as string);
  }
  return found[0];
}

/** Every file below `dir` — relative path → bytes; a symlink or anything but a regular file is a problem. */
function readTree(dir: string, problems: string[], prefix = ''): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store') continue; // as docs-ship: a Finder leaves it behind
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const [inner, bytes] of readTree(path, problems, `${prefix}${name}/`)) found.set(inner, bytes);
    else if (stat.isFile()) found.set(`${prefix}${name}`, readFileSync(path));
    else problems.push(`${LINES_DIR}/…/${prefix}${name} is not a regular file (a symlink or something else)`);
  }
  return found;
}

/** What is wrong with the pins and the snapshots of `root`; [] when every line holds. */
export function verifyLines(options: LinesOptions): string[] {
  const { root } = options;
  const git = options.git ?? gitIn(root);
  const log = options.log ?? (() => {});
  const problems: string[] = [];
  let pins: Record<string, LinePin>;
  try {
    pins = readPins(root);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const linesDir = join(root, LINES_DIR);
  const present = existsSync(linesDir) ? readdirSync(linesDir).filter((name) => name !== '.DS_Store').sort() : [];
  for (const name of present) if (!(name in pins)) problems.push(`${LINES_DIR}/${name} has no pin in ${PINS_FILE}`);
  for (const line of Object.keys(pins)) if (!present.includes(line)) problems.push(`${line} is pinned, but ${LINES_DIR}/${line}/ is missing`);

  for (const [line, pin] of Object.entries(pins)) {
    const where = `${line} (${pin.tag})`;
    const before = problems.length;
    try {
      const remote = remoteTagCommit(git, pin.tag);
      if (remote === undefined) problems.push(`${where}: the remote named origin has no annotated tag ${pin.tag} any more (in a fork, origin is the fork: check git remote get-url origin)`);
      else if (remote !== pin.commit) problems.push(`${where}: the tag on origin is ${remote}, the pin ${pin.commit} — the tag was moved; the site keeps showing the pinned commit`);

      if (!git.succeeds(['cat-file', '-e', `${pin.commit}^{commit}`])) {
        // Depth only in a checkout that is shallow already: a full clone must not become one.
        const shallow = git.capture(['rev-parse', '--is-shallow-repository']).trim() === 'true';
        git.capture(['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', pin.commit]);
      }
      const expected = snapshotOf(git, pin.commit, pin.version);
      if (!present.includes(line)) continue;
      const treeProblems: string[] = [];
      const actual = readTree(join(linesDir, line), treeProblems);
      problems.push(...treeProblems.map((problem) => `${where}: ${problem}`));
      for (const [path, bytes] of expected) {
        const have = actual.get(path);
        if (have === undefined) problems.push(`${where}: ${path} is missing in the snapshot`);
        else if (!have.equals(bytes)) problems.push(`${where}: ${path} differs from the commit ${pin.commit}`);
      }
      for (const path of actual.keys()) if (!expected.has(path)) problems.push(`${where}: ${path} is in the snapshot, but not in the commit`);
      if (problems.length === before) log(`website-lines: ${where}: ${expected.size} files equal the commit ${pin.commit}`);
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [mode, tag] = process.argv.slice(2);
  const log = (line: string) => console.log(line);
  try {
    if (mode === 'add' && tag !== undefined) addLine(tag, { root, log });
    else if (mode === 'verify' && tag === undefined) {
      const problems = verifyLines({ root, log });
      if (problems.length > 0) {
        console.error(`website-lines: ${problems.length} problem(s):\n${problems.map((problem) => `  ✗ ${problem}`).join('\n')}`);
        process.exitCode = 1;
      } else if (Object.keys(readPins(root)).length === 0) log('website-lines: no release lines');
    } else {
      console.error('Usage: node scripts/website-lines.ts add <tag> | verify');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`website-lines: ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
