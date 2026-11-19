import { Application } from '@marmeon/core';
import type { CommandInput } from '../command.ts';
import { exitCodeOf, reportJson, unrunReport, type CheckReport } from '../check/report.ts';
import { printReports } from '../check/print.ts';
import { checkRegistryOf, describeFailure, discoveredChecks, runAppChecks } from '../check/app.ts';
import { BUILT_IN_CHECKS } from '../check/registry.ts';
import { innerHtmlCheck, rawSqlCheck } from '../check/source-rules.ts';
import { packagesCheck } from '../check/packages.ts';
import { agentsCheck,internalImportsCheck, lintCheck, TOOL_CHECKS, typesCheck, type CheckRun } from '../check/tools.ts';
import { appRedactor, loadApplication } from '../load.ts';

/** The process exits with this when `marmeon check` is called wrongly (see docs/check.md#exit-codes). */
const EXIT_USAGE = 2;

/**
 * `marmeon check`: the type check, the lint, the scans of the source for imports of framework internals and for raw SQL built from values, the block of `AGENTS.md`, the versions of the @marmeon packages and the checks that need the app —
 * its route and database types, its modules, the boot and readiness, and the checks packages add — with named results, exit codes
 * and `--json`. Loads the app itself (twice: registered, then booted) only when one of those is selected. See docs/check.md#the-checks.
 */
export class CheckCommand {
  static command = 'check';
  static description = 'Check the app: types, lint, imports of framework internals, raw SQL, the block of AGENTS.md, the versions of the @marmeon packages, route and database types, boot and readiness';
  static usage = '[--only=<names>] [--skip=<names>] [--json]';
  static options = { only: { type: 'string' }, skip: { type: 'string' }, json: { type: 'boolean' } } as const;
  static boots = false;

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const only = list(options.only);
    const skip = list(options.skip);
    const tools: readonly string[] = TOOL_CHECKS;
    const builtIn: readonly string[] = BUILT_IN_CHECKS;
    // The app is loaded when a check that needs it may be selected, or a name is not one of marmeon's own (a package's check is known only then).
    const loads = only === undefined || only.some((name) => !tools.includes(name)) || [...(only ?? []), ...(skip ?? [])].some((name) => !builtIn.includes(name));
    const build = loads ? await loadApplication(root, 'build') : undefined;

    // marmeon's own names in report order, the app's checks between `boot` and `readiness`; an app that did not load knows those of the installed packages only.
    const registry = build instanceof Error || build === undefined ? undefined : checkRegistryOf(build);
    const known = build instanceof Error ? await discoveredChecks(root) : { build: registry?.all('build').map((check) => check.check) ?? [], run: registry?.all('run').map((check) => check.check) ?? [] };
    const names: string[] = [
      ...TOOL_CHECKS,
      'boot',
      ...known.build,
      ...known.run,
      'readiness',
    ];
    const usage = (problem: string) => {
      const note = build instanceof Error ? ' The app did not load, so the checks it adds itself are not known.' : '';
      output.error(`${problem}. The checks are: ${names.join(', ')}.${note}\nUsage: marmeon check ${CheckCommand.usage}`);
      return EXIT_USAGE;
    };
    const warnings: string[] = [];
    // An app that did not load cannot say which checks it adds: a name nobody knows is then no wrong call but a warning, and `boot` runs
    // so that the failure of the app is the result.
    const unknown = new Set<string>();
    for (const [flag, given] of [['--only', only], ['--skip', skip]] as const) {
      const wrong = given?.filter((name) => !names.includes(name));
      if (wrong && given!.length === 0) {
        if (build instanceof Application) await build.shutdown();
        return usage(`${flag} needs check names`);
      }
      if (wrong && wrong.length > 0) {
        if (!(build instanceof Error)) {
          if (build instanceof Application) await build.shutdown();
          return usage(`${flag} names no check: ${wrong.join(', ')}`);
        }
        for (const name of wrong) unknown.add(name);
      }
    }
    let selected = names.filter((name) => (only ? only.includes(name) : true) && !skip?.includes(name));
    if (build instanceof Error) {
      if (unknown.size > 0 && !selected.includes('boot')) selected = names.filter((name) => name === 'boot' || selected.includes(name));
      // Only a report that holds app checks (or `boot` itself) misses the checks the app adds.
      if (selected.some((name) => !tools.includes(name))) warnings.push('The app did not load, so the checks it adds itself are not in this report.');
      if (unknown.size > 0) warnings.push(`No check is known by the name ${[...unknown].join(', ')}: they may be checks the app adds itself.`);
    }
    if (selected.length === 0) {
      if (build instanceof Application) await build.shutdown();
      return usage('--only and --skip leave no check to run');
    }

    const runners: Record<string, () => Promise<CheckRun> | CheckRun> = {
      types: () => typesCheck(root),
      lint: () => lintCheck(root),
      'internal-imports': () => internalImportsCheck(root),
      'raw-sql': () => rawSqlCheck(root),
      'inner-html': () => innerHtmlCheck(root),
      agents: () => agentsCheck(root),
      packages: () => packagesCheck(root),
    };
    const toolRuns = Promise.all(selected.filter((name) => tools.includes(name)).map(async (name) => runners[name]!()));
    const appNames = selected.filter((name) => !tools.includes(name));
    const appReports = new Map<string, CheckReport>();
    let unowned = 0;
    try {
      if (appNames.length > 0 && build) ({ unowned } = await runAppChecks({ root, build, selected: appNames, reports: appReports, warnings }));
      else if (build instanceof Application) await build.shutdown();
    } catch (error) {
      // Whatever the run of the app's checks threw: the reports it finished stay, the others could not say.
      for (const name of appNames) if (!appReports.has(name)) appReports.set(name, unrunReport(name, 'error', describeFailure(error, await appRedactor(root), root), 0));
    }
    const runs = [...(await toolRuns), ...appNames.filter((name) => appReports.has(name)).map((name): CheckRun => ({ report: appReports.get(name)! }))];
    const reports = runs.map((run) => run.report);
    // A failure outside every check is no finding, but a run that had one did not finish cleanly.
    const exitCode = unowned > 0 && exitCodeOf(reports) === 0 ? 3 : exitCodeOf(reports);

    if (options.json === true) {
      output.json({ format: 1, ok: exitCode === 0, exitCode, checks: reports.map(reportJson), warnings });
      return exitCode;
    }
    printReports(output, runs, warnings, exitCode);
    return exitCode;
  }
}

/** A comma list option (`--only=types,lint`); undefined when the option is not given. */
function list(value: unknown): string[] | undefined {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : undefined;
}
