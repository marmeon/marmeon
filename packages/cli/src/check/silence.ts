import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { sourceComments } from '@marmeon/core/internal';
import { sourceFiles } from './files.ts';
import { escapeControl, type CheckProblem, type SilencedProblem } from './report.ts';

/** The checks a comment can silence. `internal-imports` is not among them: a framework internal is never an exception. */
export type SilenceableCheck = 'raw-sql' | 'inner-html' | 'throttle';

const DIRECTIVE = /^\s*marmeon-check-ignore\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*(?::\s*(.*?))?\s*$/;
const MAX_REASON = 200;
const DOCS = 'docs/check.md#silencing-a-finding';

interface Directive {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  /** Alone on its line: only then does it reach the next line. */
  readonly ownLine: boolean;
  /** More than one check named in the comment. */
  readonly shared: boolean;
  readonly reason: string | undefined;
}

/** The text of a comment as one line, without the `*` that starts the lines of a block comment. */
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\*+/, '').trim())
    .join(' ');
}

/** The comments in the app's sources that name `check`; real comments only — the text of a string silences nothing. */
function directivesOf(check: SilenceableCheck, root: string): Directive[] {
  const found: Directive[] = [];
  for (const path of sourceFiles(root, { tests: false })) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('marmeon-check-ignore')) continue;
    const file = relative(root, path).split('\\').join('/');
    for (const comment of sourceComments(text, path.slice(path.lastIndexOf('/') + 1)) ?? []) {
      const match = DIRECTIVE.exec(oneLine(comment.text));
      if (!match || !match[1]!.split(',').some((name) => name.trim() === check)) continue;
      const reason = match[2]?.trim();
      const names = match[1]!.split(',');
      found.push({
        file,
        line: comment.line,
        endLine: comment.endLine,
        ownLine: comment.ownLine,
        shared: names.length > 1,
        reason: reason ? escapeControl(reason.slice(0, MAX_REASON)) : undefined,
      });
    }
  }
  return found;
}

/**
 * Splits the findings of `check` into those a `// marmeon-check-ignore <check>: <reason>` comment silences — on the line the
 * comment ends on, or the one after it when the comment is alone on its line — and the rest. A comment without a reason silences nothing and is a warning of its own,
 * and so is a comment that covers no finding. A name that is no check of this list silences nothing and is not reported.
 * See docs/check.md#silencing-a-finding.
 */
export function silence(check: SilenceableCheck, root: string, problems: readonly CheckProblem[]): { problems: CheckProblem[]; silenced: SilencedProblem[] } {
  const directives = directivesOf(check, root);
  const covers = (directive: Directive, problem: CheckProblem) =>
    problem.file === directive.file && problem.line !== undefined && (problem.line === directive.endLine || (directive.ownLine && problem.line === directive.endLine + 1));
  const silenced: SilencedProblem[] = [];
  const kept: CheckProblem[] = [];
  for (const problem of problems) {
    const by = directives.find((directive) => directive.reason !== undefined && covers(directive, problem));
    if (by) silenced.push({ ...problem, reason: by.reason! });
    else kept.push(problem);
  }
  for (const directive of directives) {
    const covered = problems.some((problem) => covers(directive, problem));
    const message = !covered
      ? directive.shared
        ? `\`${check}\` finds nothing on this line or the next — remove it from this comment`
        : `This comment silences nothing — remove it. A \`marmeon-check-ignore ${check}\` comment goes on the line of the finding or the line above it.`
      : directive.reason === undefined
        ? `This comment needs a reason after the colon: \`marmeon-check-ignore ${check}: <why this is safe>\`. Without one it silences nothing.`
        : undefined;
    if (message === undefined) continue;
    kept.push({ severity: 'warning', message, file: directive.file, line: directive.line, rule: 'marmeon(check-ignore)', docs: DOCS });
  }
  return { problems: kept, silenced };
}
