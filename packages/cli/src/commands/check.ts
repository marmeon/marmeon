import type { CommandInput } from '../command.ts';
import { escapeControl, exitCodeOf, reportJson, type CheckProblem } from '../check/report.ts';
import { internalImportsCheck, lintCheck, TOOL_CHECKS, typesCheck, type CheckRun } from '../check/tools.ts';

/** The process exits with this when `marmeon check` is called wrongly (see docs/check.md#exit-codes). */
const EXIT_USAGE = 2;

/**
 * `marmeon check`: the type check, the lint and the scan for imports of framework internals, with named results, exit codes
 * and `--json`. Runs without booting the app. See docs/check.md#the-checks.
 */
export class CheckCommand {
  static command = 'check';
  static description = 'Check the app: types, lint and imports of framework internals';
  static usage = '[--only=<names>] [--skip=<names>] [--json]';
  static options = { only: { type: 'string' }, skip: { type: 'string' }, json: { type: 'boolean' } } as const;
  static boots = false;

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const names: readonly string[] = TOOL_CHECKS;
    const only = list(options.only);
    const skip = list(options.skip);
    for (const [flag, given] of [['--only', only], ['--skip', skip]] as const) {
      const unknown = given?.filter((name) => !names.includes(name));
      if (unknown && (unknown.length > 0 || given!.length === 0)) {
        output.error(`${flag} ${unknown.length > 0 ? `names no check: ${unknown.join(', ')}` : 'needs check names'}. The checks are: ${names.join(', ')}.\nUsage: marmeon check ${CheckCommand.usage}`);
        return EXIT_USAGE;
      }
    }
    const selected = names.filter((name) => (only ? only.includes(name) : true) && !skip?.includes(name));
    if (selected.length === 0) {
      output.error(`--only and --skip leave no check to run. The checks are: ${names.join(', ')}.\nUsage: marmeon check ${CheckCommand.usage}`);
      return EXIT_USAGE;
    }

    const runners: Record<string, () => Promise<CheckRun> | CheckRun> = {
      types: () => typesCheck(root),
      lint: () => lintCheck(root),
      'internal-imports': () => internalImportsCheck(root),
    };
    const runs = await Promise.all(selected.map(async (name) => runners[name]!()));
    const reports = runs.map((run) => run.report);
    const exitCode = exitCodeOf(reports);

    if (options.json === true) {
      output.json({ format: 1, ok: exitCode === 0, exitCode, checks: reports.map(reportJson), warnings: [] });
      return exitCode;
    }
    for (const { report, raw } of runs) {
      const errors = report.problems.filter((problem) => problem.severity === 'error').length;
      const warnings = report.problems.length - errors;
      const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
      if (report.status === 'passed') output.success(`${report.name}`);
      else if (report.status === 'skipped') output.line(`- ${report.name} skipped: ${escapeControl(report.reason ?? '')}`);
      else if (report.status === 'error') output.error(`${report.name} — could not run: ${escapeControl(report.reason ?? '')}`);
      else if (report.status === 'warning') output.warn(`${report.name} — ${count(warnings, 'warning')}`);
      else output.error(`${report.name} — ${[errors > 0 ? count(errors, 'error') : '', warnings > 0 ? count(warnings, 'warning') : ''].filter(Boolean).join(', ')}`);
      for (const problem of report.problems) output.line(describe(problem));
      if (raw && report.status === 'failed') process.stdout.write(escapeControl(raw.endsWith('\n') ? raw : `${raw}\n`, true));
    }
    output.line();
    output.line(
      exitCode === 0
        ? 'Passed (exit 0).'
        : exitCode === 1
          ? 'Failed: a check found errors (exit 1).'
          : 'A check could not run, and none found errors (exit 3).',
    );
    return exitCode;
  }
}

/** A comma list option (`--only=types,lint`); undefined when the option is not given. */
function list(value: unknown): string[] | undefined {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : undefined;
}

/** `file:line:column  message  (code/rule)` and the command that fixes it. */
function describe(problem: CheckProblem): string {
  const place = problem.file ? `${escapeControl(problem.file)}${problem.line === undefined ? '' : `:${problem.line}${problem.column === undefined ? '' : `:${problem.column}`}`}  ` : '';
  const tag = [problem.code, problem.rule].filter(Boolean).join('/');
  const lines = [`  ${place}${escapeControl(problem.message, true)}${tag ? `  (${tag})` : ''}`];
  if (problem.fix) lines.push(`  $ ${problem.fix}`);
  if (problem.docs) lines.push(`  docs: ${problem.docs}`);
  return lines.join('\n');
}
