import type { Output } from '../output.ts';
import { escapeControl, type CheckProblem, type SilencedProblem } from './report.ts';
import type { CheckRun } from './tools.ts';

/**
 * Prints what `marmeon check` and `marmeon doctor` print without `--json`: the warnings, one block per check, and the line that
 * names the exit code. `raw` (the type checker's own output) follows the findings of a failed check.
 */
export function printReports(output: Output, runs: readonly CheckRun[], warnings: readonly string[], exitCode: 0 | 1 | 3): void {
  for (const warning of warnings) output.warn(escapeControl(warning, true));
  for (const { report, raw } of runs) {
    const errors = report.problems.filter((problem) => problem.severity === 'error').length;
    const warnings = report.problems.length - errors;
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const silenced = report.silenced ?? [];
    const tally = silenced.length > 0 ? ` (${silenced.length} silenced)` : '';
    if (report.status === 'passed') output.success(`${report.name}${tally}`);
    else if (report.status === 'skipped') output.line(`- ${report.name} skipped: ${indented(report.reason ?? '', '  ')}`);
    else if (report.status === 'error') output.error(`${report.name} — could not run: ${indented(report.reason ?? '', '  ')}`);
    else if (report.status === 'warning') output.warn(`${report.name} — ${count(warnings, 'warning')}${tally}`);
    else output.error(`${report.name} — ${[errors > 0 ? count(errors, 'error') : '', warnings > 0 ? count(warnings, 'warning') : ''].filter(Boolean).join(', ')}${tally}`);
    for (const problem of report.problems) output.line(describe(problem));
    for (const problem of silenced) output.line(describeSilenced(problem));
    if (raw && report.status === 'failed') process.stdout.write(escapeControl((raw.endsWith('\n') ? raw : `${raw}\n`).replaceAll('\r\n', '\n'), true));
  }
  output.line();
  output.line(
    exitCode === 0
      ? 'Passed (exit 0).'
      : exitCode === 1
        ? 'Failed: a check found errors (exit 1).'
        : 'A check could not run, or something failed outside every check, and none found errors (exit 3).',
  );
}

/** `text` with control characters written out; the lines after the first are indented, so a message cannot pass for a line of the report. */
function indented(text: string, indent: string): string {
  return escapeControl(text, true).split('\n').join(`\n${indent}`);
}

/** `silenced  file:line  reason`: a finding a comment silenced, kept in sight. */
function describeSilenced(problem: SilencedProblem): string {
  const place = problem.file ? `${escapeControl(problem.file)}${problem.line === undefined ? '' : `:${problem.line}`}` : '';
  return `  silenced  ${place}  ${escapeControl(problem.reason)}`;
}

/** `file:line:column  message  (code/rule)` and the command that fixes it. */
function describe(problem: CheckProblem): string {
  const place = problem.file ? `${escapeControl(problem.file)}${problem.line === undefined ? '' : `:${problem.line}${problem.column === undefined ? '' : `:${problem.column}`}`}  ` : '';
  const tag = escapeControl([problem.code, problem.rule].filter(Boolean).join('/'));
  const lines = [`  ${place}${indented(problem.message, '    ')}${tag ? `  (${tag})` : ''}`];
  if (problem.fix) lines.push(`  $ ${escapeControl(problem.fix)}`);
  if (problem.docs) lines.push(`  docs: ${escapeControl(problem.docs)}`);
  return lines.join('\n');
}
