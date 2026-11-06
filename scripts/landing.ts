/**
 * The landing page's code (`apps/website/modules/site/snippets.ts`) and its checks. Every snippet names the file it is a piece of
 * (`source`): a file of the smoke app (`app`) or of this repository (`repo`). `landingProblems` compares what it can without the
 * smoke app, in `pnpm test`. A function, no command of its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import { SNIPPETS, type Snippet } from '../apps/website/modules/site/snippets.ts';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));

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

/**
 * What is wrong with the landing's snippets and typo chain, one message each: a snippet without a source, a `repo` source that
 * is missing or does not hold the code, an `app` path that is absolute, leaves the app or holds more than one `*`, a `file`
 * label that does not fit the source, and a chain step whose `find` is not exactly once in its snippet, whose `replace` equals
 * `find` or whose snippet is not from the app. Whether an `app` file holds the code is for `pnpm pack:smoke`. Empty when all is well.
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
      else if (snippet.file !== undefined && !labelMatches(source.app, snippet.file)) problems.push(`snippet "${name}": the file label "${snippet.file}" does not fit the source ${source.app}.`);
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
    if (count !== 1) problems.push(`chain step "${step.id}": ${JSON.stringify(step.typo.find)} must stand exactly once in snippet "${step.snippet}", not ${count} times.`);
    if (!snippet.source || !('app' in snippet.source)) problems.push(`chain step "${step.id}": snippet "${step.snippet}" must have an app source, which the type check can run on.`);
  }
  return problems;
}
