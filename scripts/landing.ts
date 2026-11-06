/**
 * The landing page's code (`apps/website/modules/site/snippets.ts`) and its checks. Every snippet names the file it is a piece of
 * (`source`): a file of the smoke app (`app`) or of this repository (`repo`); the code is a verbatim piece of that file once the
 * file's comment lines are left out (`withoutCommentLines`), for the landing shows no comments. `landingProblems` compares what it can without the
 * smoke app, in `pnpm test`. A function, no command of its own.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import { SNIPPETS, type Snippet } from '../apps/website/modules/site/snippets.ts';
import { typecheckApp } from '../packages/cli/src/typecheck.ts';
import { applyOverlay, readEdits, type DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';
import { oxc } from './source-files.ts';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));

/**
 * `text` of the file `filename` without its comment lines: every line whose only content (besides white space) lies inside
 * comments — a `//` line, a JSDoc, each line of a block comment. The other lines stay as they are, indentation included, and so do
 * blank lines; a comment after code stays on its line. The comments are the ones oxc-parser reports, so a `//` in a string, a
 * template, a regular expression or JSX text is not taken for one. A file the parser cannot read is an `Error` that names it: nothing
 * is stripped from a file that did not parse. The extension of `filename` picks TypeScript or TSX.
 */
export function withoutCommentLines(text: string, filename: string): string {
  const { comments, errors } = oxc().parseSync(filename, text);
  if (errors.length > 0) throw new Error(`${filename}: oxc-parser cannot read it: ${errors[0]!.message}`);
  const inComment = (offset: number) => comments.some((comment) => offset >= comment.start && offset < comment.end);
  let offset = 0;
  return text
    .split('\n')
    .filter((line) => {
      const start = offset;
      offset += line.length + 1;
      let comment = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i]!.trim() === '') continue;
        if (!inComment(start + i)) return true;
        comment = true;
      }
      return !comment;
    })
    .join('\n');
}

/**
 * Whether a snippet's code has a comment line. A snippet that parses on its own is judged like a file (`withoutCommentLines`). A
 * fragment that does not parse is judged by its text: any line that starts with `//`, `/*` or `*`, or holds `*\/`, counts — that
 * check can only say "yes" more often, never miss a line it could not read.
 */
function hasCommentLine(snippet: Snippet): boolean {
  try {
    return withoutCommentLines(snippet.code, `snippet.${snippet.lang}`) !== snippet.code;
  } catch {
    return snippet.code.split('\n').some((line) => /^\s*(\/\/|\/\*|\*)/.test(line) || line.includes('*/'));
  }
}

/** `withoutCommentLines` of the file `file`, or the message that says it cannot be read. */
function readWithoutComments(file: string): { text: string } | { problem: string } {
  try {
    return { text: withoutCommentLines(readFileSync(file, 'utf8'), file) };
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

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

/** The overlays of `examples`: the landing, the notes demo and each recipe, as directories. */
function overlays(repository: string): string[] {
  const recipes = join(repository, 'examples/recipes');
  const each = existsSync(recipes) ? readdirSync(recipes, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(recipes, entry.name)) : [];
  return [join(repository, 'examples/landing'), join(repository, 'examples/notes'), ...each];
}

/** The file of an overlay's `files` (the landing, the notes demo, a recipe) that holds the app file `path`, unless an edit of an overlay changes it afterwards. */
function overlayFile(repository: string, path: string): string | undefined {
  const all = overlays(repository);
  const edited = all.some((overlay) => existsSync(join(overlay, 'edits.json')) && readEdits(overlay).some((edit) => labelMatches(edit.file, path)));
  if (edited) return undefined;
  return all.map((overlay) => join(overlay, 'files', path)).find((file) => existsSync(file));
}

/**
 * The first bracket of `code` that has no partner (`{}`, `()`, `[]`), or a string or template literal that is not closed, as a
 * sentence; `undefined` when all pair up. Strings, template literals (with what is in their `${…}`) and comments are skipped, so a
 * bracket in a text does not count. It reads TypeScript: JSX text and regular expression literals are not understood (an apostrophe
 * in JSX text would start a string).
 */
export function bracketProblem(code: string): string | undefined {
  const closers: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    const next = code[i + 1];
    if (char === '/' && next === '/') i = (code.indexOf('\n', i) === -1 ? code.length : code.indexOf('\n', i)) - 1;
    else if (char === '/' && next === '*') i = (code.indexOf('*/', i + 2) === -1 ? code.length : code.indexOf('*/', i + 2) + 1);
    else if (char === "'" || char === '"' || char === '`') {
      let depth = 0;
      let closed = false;
      for (i++; i < code.length; i++) {
        const inner = code[i]!;
        if (inner === '\\') i++;
        else if (char !== '`' && inner === '\n') break;
        else if (char === '`' && inner === '$' && code[i + 1] === '{') {
          depth++;
          i++;
        } else if (depth > 0 && inner === '{') depth++;
        else if (depth > 0 && inner === '}') depth--;
        else if (inner === char && depth === 0) {
          closed = true;
          break;
        }
      }
      if (!closed) return 'a string or template literal is not closed.';
    } else if (char in closers) stack.push(closers[char]!);
    else if (char === '}' || char === ')' || char === ']') {
      const expected = stack.pop();
      if (expected === undefined) return `a "${char}" has no opening bracket.`;
      if (expected !== char) return `a "${expected}" is missing before "${char}".`;
    }
  }
  return stack.length > 0 ? `a "${stack.at(-1)}" is missing.` : undefined;
}

/** The first line of `code` that `text` does not hold, for a message. */
function firstMissingLine(code: string, text: string): string {
  return code.split('\n').find((line) => line.trim() !== '' && !text.includes(line)) ?? code.split('\n')[0]!;
}

/**
 * What is wrong with the landing's snippets and typo chain, one message each: a snippet without a source, a `repo` source that
 * is missing or does not hold the code, an `app` path that is absolute, leaves the app or holds more than one `*`, a `file`
 * label that does not fit the source, a `battery…` snippet of fewer than 4 or more than 10 lines or with brackets that do not pair up, a snippet whose `app` file is one of an overlay's `files` in `examples` (the landing, the notes demo, a recipe; no
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
    if (hasCommentLine(snippet)) problems.push(`snippet "${name}": it has a comment line — the landing shows code without comments; the source file may keep them.`);
    if ('app' in source) {
      const problem = appPathProblem(source.app);
      if (problem) problems.push(`snippet "${name}": ${problem}`);
      else {
        if (snippet.file !== undefined && !labelMatches(source.app, snippet.file)) problems.push(`snippet "${name}": the file label "${snippet.file}" does not fit the source ${source.app}.`);
        const file = source.app.includes('*') ? undefined : overlayFile(repository, source.app);
        const read = file ? readWithoutComments(file) : undefined;
        if (file && read) {
          if ('problem' in read) problems.push(`snippet "${name}": ${read.problem}`);
          else if (!read.text.includes(snippet.code)) problems.push(`snippet "${name}": the code is not in ${relative(repository, file)}: ${JSON.stringify(firstMissingLine(snippet.code, read.text))} is not there.`);
        }
      }
    } else if ('repo' in source) {
      const path = source.repo;
      if (path === '' || isAbsolute(path) || path.split('/').includes('..')) {
        problems.push(`snippet "${name}": its repo path must be relative and without "..".`);
        continue;
      }
      const file = join(repository, path);
      if (!existsSync(file)) problems.push(`snippet "${name}": the source ${path} does not exist.`);
      else {
        const read = readWithoutComments(file);
        if ('problem' in read) problems.push(`snippet "${name}": ${read.problem}`);
        else if (!read.text.includes(snippet.code)) problems.push(`snippet "${name}": the code is not in ${path}.`);
      }
      if (snippet.file !== undefined && snippet.file !== path.replace(/^apps\/[^/]+\//, '')) problems.push(`snippet "${name}": the file label "${snippet.file}" does not fit the source ${path}.`);
    } else {
      problems.push(`snippet "${name}": its source must be { app } or { repo }.`);
    }
  }
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!name.startsWith('battery')) continue;
    const lines = snippet.code.replace(/\n$/, '').split('\n').length;
    if (lines < 4 || lines > 10) problems.push(`snippet "${name}": a battery excerpt has 4 to 10 lines, not ${lines}.`);
    const unbalanced = bracketProblem(snippet.code);
    if (unbalanced) problems.push(`snippet "${name}": a battery excerpt must be a complete unit, ${unbalanced}`);
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
    if (!/^TS\d+$/.test(step.error?.code ?? '')) problems.push(`chain step "${step.id}": the error code must look like TS2322.`);
    if (typeof step.error?.message !== 'string' || step.error.message === '' || step.error.message.includes('\n')) problems.push(`chain step "${step.id}": the error message must be the first line of the compiler's message, not empty.`);
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

/** The diagnostics of a failed type check, one per line as `file(line,col): TScode message`. */
function listed(result: Awaited<ReturnType<typeof typecheckApp>>): string {
  if (result.status !== 'failed') return result.status;
  return result.diagnostics.map((d) => `${d.file ?? '(no file)'}${d.line === undefined ? '' : `(${d.line},${d.column})`}: ${d.code} ${d.message.split('\n')[0]}`).join('\n');
}

/**
 * Proves one typo of the chain on the app: `find` stands exactly once in `file` (relative to `app`); with `replace` in its place the
 * type check fails with exactly one error, in that file on the line of `find`, with the step's code and message as its first line.
 * The file is restored in any case. Otherwise a `SmokeError` that lists what the compiler said.
 */
export async function checkTypo(app: string, file: string, step: ChainStepSpec): Promise<void> {
  const path = join(app, file);
  const original = readFileSync(path, 'utf8');
  const count = occurrences(original, step.typo.find);
  if (count !== 1) throw new SmokeError(`chain step "${step.id}": ${JSON.stringify(step.typo.find)} must stand exactly once in ${file}, not ${count} times.`);
  const line = original.slice(0, original.indexOf(step.typo.find)).split('\n').length;
  let result: Awaited<ReturnType<typeof typecheckApp>>;
  writeFileSync(path, original.replace(step.typo.find, () => step.typo.replace));
  try {
    result = await typecheckApp(app, { pretty: false });
  } finally {
    writeFileSync(path, original);
  }
  const where = `chain step "${step.id}" (${file}:${line})`;
  if (result.status === 'passed') throw new SmokeError(`${where}: the typo compiles.`);
  if (result.status !== 'failed') throw new SmokeError(`${where}: the app could not be type-checked (${result.status}).`);
  const [only] = result.diagnostics;
  const first = only?.message.split('\n')[0];
  if (result.diagnostics.length !== 1 || only?.file !== file || only.line !== line || only.code !== step.error.code || first !== step.error.message) {
    throw new SmokeError(`${where}: expected one error, ${step.error.code} ${step.error.message}, on line ${line}; the compiler said:\n${listed(result)}`);
  }
}

/**
 * The landing on the smoke app after the notes demo (and the recipes): `examples/landing` applied; every `app` snippet word for
 * word in its file of the app (a `*` finds exactly one); the overlay's tests run; type check; lint; then each typo of the chain
 * fails with the error the page names (`checkTypo`), and the app type-checks again. A difference is a `SmokeError` with the
 * snippet's or step's name.
 */
export async function checkLanding(
  smoke: DemoTarget,
  pm: 'pnpm',
  repository: string = REPOSITORY,
  snippets: Readonly<Record<string, Snippet>> = SNIPPETS,
  chain: readonly ChainStepSpec[] = CHAIN,
  overlay: string = join(repository, 'examples/landing'),
): Promise<void> {
  const problems = landingProblems(repository, snippets, chain);
  if (problems.length > 0) throw new SmokeError(`the landing's snippets are wrong:\n${problems.join('\n')}`);
  applyOverlay(smoke.app, (args) => void smoke.run(pm, ['exec', 'marmeon', ...args]), overlay);
  const fileOf = (name: string, path: string) => {
    const found = appFiles(smoke.app, path);
    if (found.length !== 1) throw new SmokeError(`snippet "${name}": ${path} must match exactly one file of the app, it matches ${found.length}${found.length > 0 ? ` (${found.join(', ')})` : ''}.`);
    return found[0]!;
  };
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!('app' in snippet.source)) continue;
    const file = fileOf(name, snippet.source.app);
    const read = readWithoutComments(join(smoke.app, file));
    if ('problem' in read) throw new SmokeError(`snippet "${name}": ${read.problem}`);
    const text = read.text;
    if (!text.includes(snippet.code)) throw new SmokeError(`snippet "${name}": the code is not in ${file}: ${JSON.stringify(firstMissingLine(snippet.code, text))} is not there.`);
  }
  const tests = smoke.run(pm, ['run', 'test', '--reporter=verbose']);
  for (const file of testFilesBelow(join(overlay, 'files'))) if (!tests.includes(file)) throw new SmokeError(`vitest did not run ${file}, a test of the landing:\n${tests}`);
  if (!/Tests\s+\d+ passed/.test(tests)) throw new SmokeError(`the landing's tests did not pass:\n${tests}`);
  smoke.run(pm, ['run', 'typecheck']);
  smoke.run(pm, ['run', 'lint', '--deny-warnings']);
  for (const step of chain) {
    const source = snippets[step.snippet]!.source;
    await checkTypo(smoke.app, fileOf(step.snippet, (source as { app: string }).app), step);
  }
  const after = await typecheckApp(smoke.app, { pretty: false });
  if (after.status !== 'passed') throw new SmokeError(`the app does not type-check after the typos were put back:\n${listed(after)}`);
}
