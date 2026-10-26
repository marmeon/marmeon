/**
 * The API label check, run by `.github/workflows/api-label.yml` — the labels a pull request needs when it changes a package's
 * `api.md`: a **removed** entry needs `breaking`; a **changed** entry needs `breaking`, or `api-compatible` when the change
 * breaks no app (a loosened parameter, a constructor that was only ever a type); a **new** entry needs a release label other
 * than `docs` and `internal`. `Experimental` items are not compared. A removal is never compatible, whatever the label says —
 * but a removed `Referenced, not exported` item counts as a change: an app cannot import it by name.
 *
 * The same check holds the fixtures of stored and wire formats (the `formats` directories under a package's `src/__fixtures__`): a pull request that
 * changes, renames or deletes one needs `breaking` — `api-compatible` does not lift it; a new fixture is free.
 *
 * And it holds the migrations a package ships (its stubs, the kit's among them): once a file is on `main` it never changes, moves
 * or goes, a new file sorts after every file in its directory and does not repeat the name of one in its directory, and a package
 * ships its migrations from the directories it already does (a package without any starts with `stubs/migrations`), never from a
 * new one. No label lifts that.
 *
 * The check reminds, it does not protect: a pull request runs its own copy of this file, the review is the protection. It
 * therefore loads only `node:*` and `./api-snapshot.ts`, and the workflow installs nothing.
 *
 * Environment: `LABELS`, the pull request's label names as a JSON array. `HEAD` is the merge commit GitHub builds for the pull
 * request and its first parent is the base of that merge commit, the one GitHub built last. `base.sha` may date from another moment
 * than that commit and would show what merged in between as this request's change. Anything else fails loudly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { compareSnapshots, parseSnapshot, type ApiChanges, type ApiItem } from './api-snapshot.ts';

/** How many names a message lists before it counts the rest. */
const LISTED = 10;

const label = (item: ApiItem) => (item.entry === '' ? `${item.section} ${item.name}` : `${item.entry} ${item.name}`);
const names = (items: readonly ApiItem[]) => {
  const shown = items.slice(0, LISTED).map(label).join(', ');
  return items.length > LISTED ? `${shown} and ${items.length - LISTED} more` : shown;
};

/** What a pull request's labels still owe for `changes` — one message per rule broken, `where` (a package name) in front of each. */
export function labelProblems(changes: ApiChanges, labels: readonly string[], where = ''): string[] {
  const problems: string[] = [];
  const prefix = where === '' ? '' : `${where}: `;
  const breaking = labels.includes('breaking');
  // A helper type that a public signature names is part of that signature's shape, not of the names an app can import: when
  // one goes (renamed, or a same-named `X (2)` slides down), the signature changes — it is not a removal.
  const removed = changes.removed.filter((item) => item.section !== 'referenced');
  const changed = [...changes.changed.map((change) => change.after), ...changes.removed.filter((item) => item.section === 'referenced')];
  if (removed.length > 0 && !breaking) {
    problems.push(`${prefix}removes ${names(removed)} from the public API — this needs the label "breaking" (a removal is never "api-compatible")`);
  }
  if (changed.length > 0 && !breaking && !labels.includes('api-compatible')) {
    problems.push(`${prefix}changes ${names(changed)} in the public API — this needs the label "breaking", or "api-compatible" when no app breaks`);
  }
  if (changes.added.length > 0 && (labels.includes('docs') || labels.includes('internal'))) {
    problems.push(`${prefix}adds ${names(changes.added)} to the public API — a new entry needs a release label other than "docs" and "internal"`);
  }
  return problems;
}

/** The pathspec of the fixtures of stored and wire formats. */
const FORMAT_FIXTURES = 'packages/*/src/__fixtures__/formats/**';

/**
 * The labels a pull request owes for the fixtures of formats it touched: `changes` lists them as `git diff --name-status` does
 * (a rename carries its old path). Only an added fixture is free — an old node or old data still reads the others.
 */
export function formatProblems(changes: readonly { status: string; path: string }[], labels: readonly string[]): string[] {
  if (labels.includes('breaking')) return [];
  return changes
    .filter((change) => !change.status.startsWith('A'))
    .map((change) => `changes the fixture ${change.path} of a stored or wire format — this needs the label "breaking" (add a fixture for the new version instead, and keep the old one)`);
}

/** The files under `stubs/` that count as shipped migrations. */
export const SHIPPED_MIGRATIONS = 'packages/*/stubs/**/migrations/*.ts';

/** Whether `path` (from the repository root) is a shipped migration. */
export const isShippedMigration = (path: string) => matchesGlob(path, SHIPPED_MIGRATIONS);

/** A migration's name without its timestamp: what an app matches it by. */
const identity = (name: string) => name.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '');

/**
 * The problems of the migrations a pull request touched: `changes` lists them as `git diff --raw` does (`mode` is the new mode),
 * `shipped` the migrations a directory holds in the base. An app
 * matches a migration by its name, so a shipped file whose content changes never reaches the apps that have its name, a new file
 * that sorts before a shipped one runs in the wrong order, and one that repeats the name of a shipped file in its directory is taken for it (the kit and `stubs/migrations` may share names). No label applies.
 */
export function migrationProblems(changes: readonly { status: string; path: string; mode?: string }[], shipped: (directory: string) => readonly string[]): string[] {
  const problems: string[] = [];
  for (const { status, path, mode } of changes) {
    if (!status.startsWith('A')) {
      problems.push(`${path}: a migration a package ships never changes or goes — add a new file after it (CONTRIBUTING.md › Changing a stored or wire format)`);
      continue;
    }
    if (mode === '120000' || mode === '160000') {
      problems.push(`${path}: a migration is a regular file, not a symlink or a submodule`);
      continue;
    }
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    const inDirectory = shipped(path.slice(0, slash));
    const later = inDirectory
      .filter((other) => other > name)
      .sort()[0];
    if (later !== undefined) problems.push(`${path} sorts before ${later}, which is already shipped: name it after every file in its directory`);
    const same = inDirectory.find((other) => identity(other) === identity(name));
    if (same !== undefined) problems.push(`${path} repeats the name of ${same}, which its directory already ships: an app matches a migration by its name without the timestamp — choose another name`);
  }
  return problems;
}

/**
 * The problems of the migrations a pull request added to a directory that no migration of its package ships from: moving the
 * directory would make every file there a new one for the check above. `added` are the paths with status `A`, `shippedDirectories`
 * the directories of a package in the base that hold a shipped migration. The first `stubs/migrations` of a package that ships
 * none is free.
 */
export function migrationDirectoryProblems(added: readonly string[], shippedDirectories: (pkg: string) => readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of added) {
    const pkg = path.split('/')[1] ?? '';
    const directory = path.slice(0, path.lastIndexOf('/'));
    const shipped = shippedDirectories(pkg);
    if (shipped.includes(directory)) continue;
    const first = `packages/${pkg}/stubs/migrations`;
    if (shipped.length === 0 && directory === first) continue;
    problems.push(
      `${path}: ${pkg} ships its migrations from ${shipped.length === 0 ? first : shipped.join(', ')}, and a package never moves them or adds a directory — add the file there (CONTRIBUTING.md › Changing a stored or wire format)`,
    );
  }
  return problems;
}

/** The items a label is owed for: not the experimental and not the hidden ones. */
export const stable = (items: readonly ApiItem[]) => items.filter((item) => item.section !== 'experimental' && item.section !== 'experimentalReferenced' && item.section !== 'hidden');

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The first parent of `HEAD` — what the pull request merges into — or an error saying why `HEAD` has none. */
function firstParent(): string {
  const [commit, ...parents] = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  if (parents.length !== 2) {
    throw new Error(`HEAD (${commit}) is not a merge commit with two parents (it has ${parents.length}): this check runs on the merge commit GitHub builds for a pull_request event`);
  }
  return parents[0]!;
}

/** The entries of `git diff --raw -z --no-renames`: `:<old mode> <new mode> <old id> <new id> <status>`, a NUL, the path, a NUL. */
function rawChanges(output: string): { status: string; path: string; mode: string }[] {
  const tokens = output.split('\0');
  const changes: { status: string; path: string; mode: string }[] = [];
  for (let at = 0; at + 1 < tokens.length; at += 2) {
    const [, mode = '', , , status = ''] = tokens[at]!.slice(1).split(' ');
    changes.push({ status, path: tokens[at + 1]!, mode });
  }
  return changes;
}

/** The problems of every `api.md` that differs between the first parent of `HEAD` and the working tree (a file missing on either side is empty). */
export function apiLabelProblems(labels: readonly string[]): { files: number; problems: string[] } {
  const base = firstParent();
  const files = git('diff', '--name-only', '--no-renames', base, 'HEAD', '--', 'packages/*/api.md')
    .split('\n')
    .filter((file) => file !== '');
  const problems: string[] = [];
  for (const file of files) {
    // Only a path the base does not have is a new file; any other failure of git throws and fails the check.
    const before = git('ls-tree', '--name-only', base, '--', file).trim() === '' ? '' : git('show', `${base}:${file}`);
    const after = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const where = /^# (.+)$/m.exec(after)?.[1] ?? /^# (.+)$/m.exec(before)?.[1] ?? file;
    problems.push(...labelProblems(compareSnapshots(stable(parseSnapshot(before)), stable(parseSnapshot(after))), labels, where));
  }
  const fixtures = git('diff', '--name-status', '-M', base, 'HEAD', '--', FORMAT_FIXTURES)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [status = '', path = ''] = line.split('\t');
      return { status, path };
    });
  problems.push(...formatProblems(fixtures, labels));
  const migrations = rawChanges(git('diff', '--raw', '-z', '--no-renames', base, 'HEAD', '--', `:(glob)${SHIPPED_MIGRATIONS}`));
  const blobs = (revision: string, directory: string) =>
    git('ls-tree', '-z', revision, `${directory}/`)
      .split('\0')
      .map((entry) => /^(\d+) blob [0-9a-f]+\t(.+)$/.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null && match[1] !== '120000')
      .map((match) => match[2]!);
  problems.push(...migrationProblems(migrations, (directory) => blobs(base, directory).filter((path) => path.endsWith('.ts')).map((path) => path.slice(path.lastIndexOf('/') + 1))));
  const shippedDirectories = (pkg: string) => [
    ...new Set(
      git('ls-tree', '-r', '-z', base, `packages/${pkg}/stubs/`)
        .split('\0')
        .map((entry) => /^(\d+) blob [0-9a-f]+\t(.+)$/.exec(entry))
        .filter((match): match is RegExpExecArray => match !== null && match[1] !== '120000' && isShippedMigration(match[2]!))
        .map((match) => match[2]!.slice(0, match[2]!.lastIndexOf('/'))),
    ),
  ];
  problems.push(...migrationDirectoryProblems(migrations.filter((change) => change.status.startsWith('A')).map((change) => change.path), shippedDirectories));
  return { files: files.length, problems };
}

if (import.meta.main) {
  let labels: unknown;
  try {
    labels = JSON.parse(process.env.LABELS ?? '');
  } catch {
    labels = undefined;
  }
  if (!Array.isArray(labels) || !labels.every((name) => typeof name === 'string')) {
    console.error('::error title=API label::LABELS (a JSON array of names) is required.');
    process.exit(1);
  }
  let result: ReturnType<typeof apiLabelProblems>;
  try {
    result = apiLabelProblems(labels as string[]);
  } catch (error) {
    console.error(`::error title=API label::${String(error instanceof Error ? error.message : error).replace(/[\r\n%]/g, ' ')}`);
    process.exit(1);
  }
  const { files, problems } = result;
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error title=API label::${problem.replace(/[\r\n%]/g, ' ')}`);
    process.exitCode = 1;
  } else {
    console.log(files === 0 ? 'api.md: no public change.' : `api.md: ${files} file${files === 1 ? '' : 's'} changed, and the labels cover it.`);
  }
}
