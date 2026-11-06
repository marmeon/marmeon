/**
 * The landing page's code (`apps/website/modules/site/snippets.ts`) and its checks. Every snippet names the file it is a piece of
 * (`source`): a file of the smoke app (`app`) or of this repository (`repo`). `landingProblems` compares what it can without the
 * smoke app, in `pnpm test`. A function, no command of its own.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import { SNIPPETS, type Snippet } from '../apps/website/modules/site/snippets.ts';
import { applyOverlay, readEdits, type DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));

/** `examples/landing` of this repository. */
export const LANDING = fileURLToPath(new URL('../examples/landing', import.meta.url));

/** How often `part` stands in `text`, without overlaps. */
function occurrences(text: string, part: string): number {
  return part === '' ? 0 : text.split(part).length - 1;
}

/** Whether a file name `label` is what the `app` path `source` (one `*` allowed in its last segment) stands for. */
function labelMatches(source: string, label: string): boolean {
  if (!source.includes('*')) return source === label;
  const [before, after] = source.split('*') as [string, string];
  return label.length >= before.length + after.length && label.startsWith(before) && label.endsWith(after) && !label.slice(before.length, label.length - after.length).includes('/');
}

/** The problems of one `app` path, as a sentence ending the message; empty when the path is fine. */
function appPathProblem(path: string): string | undefined {
  if (path === '' || isAbsolute(path) || path.split('/').includes('..')) return 'its app path must be relative and without "..".';
  const stars = path.split('*').length - 1;
  if (stars > 1 || (stars === 1 && path.slice(0, path.lastIndexOf('/') + 1).includes('*'))) return 'its app path may hold one "*", in the last segment.';
  return undefined;
}

/** The file of `examples/landing/files` or `examples/notes/files` that holds the app file `path`, unless an edit of those overlays changes it afterwards. */
function overlayFile(repository: string, path: string): string | undefined {
  const edited = ['landing', 'notes'].some((name) => {
    const overlay = join(repository, 'examples', name);
    return existsSync(join(overlay, 'edits.json')) && readEdits(overlay).some((edit) => labelMatches(edit.file, path));
  });
  if (edited) return undefined;
  return ['landing', 'notes'].map((name) => join(repository, 'examples', name, 'files', path)).find((file) => existsSync(file));
}

/** The first line of `code` that `text` does not hold, for a message. */
function firstMissingLine(code: string, text: string): string {
  return code.split('\n').find((line) => line.trim() !== '' && !text.includes(line)) ?? code.split('\n')[0]!;
}

/**
 * What is wrong with the landing's snippets and typo chain, one message each: a snippet without a source, a `repo` source that
 * is missing or does not hold the code, an `app` path that is absolute, leaves the app or holds more than one `*`, a `file`
 * label that does not fit the source, a snippet whose `app` file is one of `examples/landing/files` or `examples/notes/files` (no
 * edit changes it afterwards) and does not hold the code, and a chain step whose `find` is not exactly once, on one line, in its
 * snippet, whose `replace` equals `find` or whose snippet is not from the app. A file a generator writes or an edit changes is for
 * `pnpm pack:smoke`. Empty when all is well.
 */
export function landingProblems(repository: string = REPOSITORY, snippets: Readonly<Record<string, Snippet>> = SNIPPETS, chain: readonly ChainStepSpec[] = CHAIN): string[] {
  const problems: string[] = [];
  for (const [name, snippet] of Object.entries(snippets)) {
    const source = (snippet as { source?: Snippet['source'] }).source;
    if (source === undefined || typeof source !== 'object' || source === null) {
      problems.push(`snippet "${name}": it has no source — name the file it is a piece of.`);
      continue;
    }
    if ('app' in source) {
      const problem = appPathProblem(source.app);
      if (problem) problems.push(`snippet "${name}": ${problem}`);
      else {
        if (snippet.file !== undefined && !labelMatches(source.app, snippet.file)) problems.push(`snippet "${name}": the file label "${snippet.file}" does not fit the source ${source.app}.`);
        const file = source.app.includes('*') ? undefined : overlayFile(repository, source.app);
        if (file && !readFileSync(file, 'utf8').includes(snippet.code)) problems.push(`snippet "${name}": the code is not in ${relative(repository, file)}: ${JSON.stringify(firstMissingLine(snippet.code, readFileSync(file, 'utf8')))} is not there.`);
      }
    } else if ('repo' in source) {
      const path = source.repo;
      if (path === '' || isAbsolute(path) || path.split('/').includes('..')) {
        problems.push(`snippet "${name}": its repo path must be relative and without "..".`);
        continue;
      }
      const file = join(repository, path);
      if (!existsSync(file)) problems.push(`snippet "${name}": the source ${path} does not exist.`);
      else if (!readFileSync(file, 'utf8').includes(snippet.code)) problems.push(`snippet "${name}": the code is not in ${path}.`);
      if (snippet.file !== undefined && snippet.file !== path.replace(/^apps\/[^/]+\//, '')) problems.push(`snippet "${name}": the file label "${snippet.file}" does not fit the source ${path}.`);
    } else {
      problems.push(`snippet "${name}": its source must be { app } or { repo }.`);
    }
  }
  for (const step of chain) {
    const snippet = snippets[step.snippet];
    if (snippet === undefined) {
      problems.push(`chain step "${step.id}": there is no snippet "${step.snippet}".`);
      continue;
    }
    if (step.typo.replace === step.typo.find) problems.push(`chain step "${step.id}": the typo replaces ${JSON.stringify(step.typo.find)} with itself.`);
    const count = occurrences(snippet.code, step.typo.find);
    if (step.typo.find.includes('\n')) problems.push(`chain step "${step.id}": ${JSON.stringify(step.typo.find)} must sit on one line.`);
    if (count !== 1) problems.push(`chain step "${step.id}": ${JSON.stringify(step.typo.find)} must stand exactly once in snippet "${step.snippet}", not ${count} times.`);
    if (!snippet.source || !('app' in snippet.source)) problems.push(`chain step "${step.id}": snippet "${step.snippet}" must have an app source, which the type check can run on.`);
  }
  return problems;
}

/** The files of the app that `path` names: one, or those a `*` in its last segment matches. */
function appFiles(app: string, path: string): string[] {
  if (!path.includes('*')) return existsSync(resolve(app, path)) ? [path] : [];
  const directory = resolve(app, dirname(path));
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && labelMatches(basename(path), entry.name))
    .map((entry) => join(dirname(path), entry.name));
}

/** The files `*.test.ts` below `dir`, relative to it. */
function testFilesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

/**
 * The landing on the smoke app (the notes demo and the recipes may be on it already): `examples/landing` applied; every `app`
 * snippet word for word in its file of the app (a `*` finds exactly one); the overlay's tests run; type check; lint. A difference
 * is a `SmokeError` with the snippet's name.
 */
export function checkLanding(smoke: DemoTarget, pm: 'pnpm', repository: string = REPOSITORY, snippets: Readonly<Record<string, Snippet>> = SNIPPETS, overlay: string = join(repository, 'examples/landing')): void {
  const problems = landingProblems(repository, snippets, []);
  if (problems.length > 0) throw new SmokeError(`the landing's snippets are wrong:\n${problems.join('\n')}`);
  applyOverlay(smoke.app, (args) => void smoke.run(pm, ['exec', 'marmeon', ...args]), overlay);
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!('app' in snippet.source)) continue;
    const path = snippet.source.app;
    const found = appFiles(smoke.app, path);
    if (found.length !== 1) throw new SmokeError(`snippet "${name}": ${path} must match exactly one file of the app, it matches ${found.length}${found.length > 0 ? ` (${found.join(', ')})` : ''}.`);
    const text = readFileSync(join(smoke.app, found[0]!), 'utf8');
    if (!text.includes(snippet.code)) throw new SmokeError(`snippet "${name}": the code is not in ${found[0]!}: ${JSON.stringify(firstMissingLine(snippet.code, text))} is not there.`);
  }
  const tests = smoke.run(pm, ['run', 'test', '--reporter=verbose']);
  for (const file of testFilesBelow(join(overlay, 'files'))) if (!tests.includes(file)) throw new SmokeError(`vitest did not run ${file}, a test of the landing:\n${tests}`);
  if (!/Tests\s+\d+ passed/.test(tests)) throw new SmokeError(`the landing's tests did not pass:\n${tests}`);
  smoke.run(pm, ['run', 'typecheck']);
  smoke.run(pm, ['run', 'lint', '--deny-warnings']);
}
