/**
 * The API label check, run by `.github/workflows/api-label.yml` — the labels a pull request needs when it changes a package's
 * `api.md`: a **removed** entry needs `breaking`; a **changed** entry needs `breaking`, or `api-compatible` when the change
 * breaks no app (a loosened parameter, a constructor that was only ever a type); a **new** entry needs a release label other
 * than `docs` and `internal`. `Experimental` items are not compared. A removal is never compatible, whatever the label says —
 * but a removed `Referenced, not exported` item counts as a change: an app cannot import it by name.
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

const stable = (items: readonly ApiItem[]) => items.filter((item) => item.section !== 'experimental' && item.section !== 'experimentalReferenced');

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
