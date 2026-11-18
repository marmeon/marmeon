import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application } from '@marmeon/core';
import { environmentChecks, loadDiscoveredPackages } from '@marmeon/core/internal';
import type { CommandInput } from '../command.ts';
import { describeFailure, runAppChecks } from '../check/app.ts';
import { nodeCheck } from '../check/node.ts';
import { migrationsCheck, statusCommandOf, type MigrationsInput, type StatusCommand } from '../check/migrations.ts';
import { packagesCheck } from '../check/packages.ts';
import { printReports } from '../check/print.ts';
import { exitCodeOf, reportJson, unrunReport, type CheckReport } from '../check/report.ts';
import type { CheckRun } from '../check/tools.ts';
import { CheckRegistry, type AppCheckClass } from '../check/registry.ts';
import { appRedactor, loadApplication, redactorAfter } from '../load.ts';

/** The process exits with this when `marmeon doctor` is called wrongly (see docs/check.md#exit-codes). */
const EXIT_USAGE = 2;

/** The checks of `marmeon doctor`, in report order. Its own list: checks that packages register are not among them. */
export const DOCTOR_CHECKS = ['node', 'packages', 'boot', 'route-types', 'package-migrations', 'db-types', 'migrations', 'readiness'] as const;

/** One of the names of {@link DOCTOR_CHECKS}. */
export type DoctorCheck = (typeof DOCTOR_CHECKS)[number];

/** What each check needs: `tool` runs without the app, with its runner; `app` is run by the app's checks; `database` is one that `@marmeon/database` registers; `status` is run by doctor itself, in a child process, once the app's checks have run. */
const CHECKS = {
  node: { kind: 'tool', run: nodeCheck },
  packages: { kind: 'tool', run: packagesCheck },
  boot: { kind: 'app' },
  'route-types': { kind: 'app' },
  'package-migrations': { kind: 'database' },
  'db-types': { kind: 'database' },
  migrations: { kind: 'status', run: migrationsCheck },
  readiness: { kind: 'app' },
} as const satisfies Record<DoctorCheck, { kind: 'tool'; run: (root: string) => CheckRun } | { kind: 'status'; run: (root: string, input: MigrationsInput) => Promise<CheckRun> } | { kind: 'app' | 'database' }>;

/** The package and the provider whose own class a check must be: a check is told by its class, since an app may register any name. */
const OWNER: Partial<Record<DoctorCheck, { readonly package: string; readonly provider: string }>> = {
  'route-types': { package: 'marmeon', provider: 'CliServiceProvider' },
  'package-migrations': { package: '@marmeon/database', provider: 'DatabaseServiceProvider' },
  'db-types': { package: '@marmeon/database', provider: 'DatabaseServiceProvider' },
};

/** The class `static checks` of the owner's provider names `name`, loaded from the app's own copy of the package; undefined when it cannot be told. */
async function ownCheck(root: string, name: DoctorCheck): Promise<AppCheckClass | undefined> {
  const owner = OWNER[name];
  if (!owner) return undefined;
  try {
    // Only the app's node_modules chain counts, as for the package's other entries (`require.resolve` also reads NODE_PATH).
    const entry = createRequire(join(root, 'package.json')).resolve(owner.package);
    const provider = ((await import(pathToFileURL(entry).href)) as Record<string, { checks?: readonly AppCheckClass[] } | undefined>)[owner.provider];
    return provider?.checks?.find((check) => check.check === name);
  } catch {
    return undefined;
  }
}

/**
 * `marmeon doctor`: whether this machine can run the app — Node, the versions of the @marmeon packages, the configuration and `APP_KEY`,
 * the generated files, the migrations that have not run and the services — with the reports, exit codes and `--json` of `marmeon check`. See docs/check.md#the-environment-marmeon-doctor.
 */
export class DoctorCommand {
  static command = 'doctor';
  static description = 'Check that this machine can run the app: Node, packages, configuration, generated files, migrations that have not run, services';
  static usage = '[--only=<names>] [--skip=<names>] [--json]';
  static options = { only: { type: 'string' }, skip: { type: 'string' }, json: { type: 'boolean' } } as const;
  static boots = false;

  async handle({ options, output, root }: CommandInput): Promise<number> {
    const only = list(options.only);
    const skip = list(options.skip);
    const names: readonly string[] = DOCTOR_CHECKS;
    const usage = (problem: string) => {
      output.error(`${problem}. The checks are: ${names.join(', ')}.\nUsage: marmeon doctor ${DoctorCommand.usage}`);
      return EXIT_USAGE;
    };
    for (const [flag, given] of [['--only', only], ['--skip', skip]] as const) {
      if (given?.length === 0) return usage(`${flag} needs check names`);
      const wrong = given?.filter((name) => !names.includes(name));
      if (wrong && wrong.length > 0) return usage(`${flag} names no check: ${wrong.join(', ')}`);
    }
    const selected = DOCTOR_CHECKS.filter((name) => (only ? only.includes(name) : true) && !skip?.includes(name));
    if (selected.length === 0) return usage('--only and --skip leave no check to run');

    // Taken before the app loads: what `marmeon start` would refuse on this machine.
    const warnings: string[] = [];
    const nodeEnv = process.env.NODE_ENV;
    if (environmentChecks.fromDotEnv() && (nodeEnv === 'development' || nodeEnv === 'test')) {
      warnings.push(`marmeon start refuses on this machine: NODE_ENV=${nodeEnv} comes from .env alone, and doctor checked the ${nodeEnv} configuration.`);
    }
    const tools = new Map<DoctorCheck, CheckRun>();
    for (const name of selected) {
      const check = CHECKS[name];
      if (check.kind === 'tool') tools.set(name, check.run(root));
    }
    const appNames = selected.filter((name) => CHECKS[name].kind === 'app' || CHECKS[name].kind === 'database');
    const statusNames = selected.filter((name) => CHECKS[name].kind === 'status');
    const appReports = new Map<DoctorCheck, CheckReport>();
    let unowned = 0;
    let status: StatusCommand | undefined;
    // What app code rejects or throws while no check of the app runs (its load, the wait for the child of `migrations`) belongs to no check: it is kept, masked.
    const strays: unknown[] = [];
    // `runAppChecks` keeps its own strays while its checks run; this window takes the rest, from before the load to after the last check.
    let inChecks = false;
    const onStray = (error: unknown) => {
      if (!inChecks) strays.push(error);
    };
    const watching = async <T>(work: () => Promise<T>): Promise<T> => {
      process.on('unhandledRejection', onStray);
      process.on('uncaughtException', onStray);
      try {
        return await work();
      } finally {
        // A rejection that is still on its way arrives in the next turn of the loop.
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
        process.off('unhandledRejection', onStray);
        process.off('uncaughtException', onStray);
      }
    };
    let build: Application | Error | undefined;
    await watching(async () => {
      build = appNames.length > 0 || statusNames.length > 0 ? await loadApplication(root, 'build') : undefined;
      if (build !== undefined && statusNames.length > 0) {
        // Read before the checks shut the build app down.
        status = statusCommandOf(build);
        // Only the registry is needed from it: the child of `migrations` loads the app again.
        if (appNames.length === 0 && build instanceof Application) await build.shutdown().catch(() => undefined);
      }
      if (build !== undefined && appNames.length > 0) {
        // Only the class of the owning package runs under these names: any app can register a check named `db-types`, and its handler
        // must not run (it could write, connect or hang). A rejected check has no report and falls into the miss branch below.
        const own = new Map<string, AppCheckClass | undefined>();
        for (const name of appNames) if (OWNER[name]) own.set(name, await ownCheck(root, name));
        const accept = (check: AppCheckClass) => !own.has(check.check) || own.get(check.check) === check;
        inChecks = true;
        try {
          ({ unowned } = await runAppChecks({ root, build, selected: appNames, reports: appReports, warnings, accept }));
        } finally {
          inChecks = false;
        }
        // A check without a report was not registered. Only a package the app does not depend on is proof that this is no fault.
        const hasRegistry = build instanceof Application && build.container.has(CheckRegistry);
        let discovered: readonly string[] | Error | undefined;
        for (const name of appNames) {
          if (appReports.has(name)) continue;
          if (CHECKS[name].kind === 'database' && hasRegistry) {
            if (discovered === undefined) discovered = await loadDiscoveredPackages({ root }).then((found) => found.packages, (error: unknown) => (error instanceof Error ? error : new Error(String(error))));
            if (discovered instanceof Error) appReports.set(name, unrunReport(name, 'error', `the packages of the app could not be discovered: ${describeFailure(discovered, await appRedactor(root), root)}`, 0));
            else if (!discovered.includes('@marmeon/database')) appReports.set(name, unrunReport(name, 'skipped', '@marmeon/database is not installed', 0));
            else appReports.set(name, unrunReport(name, 'error', `the check ${name} is not registered: add \`DatabaseServiceProvider\` of @marmeon/database to the app's providers`, 0));
          } else {
            appReports.set(name, unrunReport(name, 'error', `the check ${name} is not registered: add \`CliServiceProvider\` of marmeon to the app's providers`, 0));
          }
        }
      }
      // After the app's checks: a `migrations` run asks whether the app loaded, and its child process starts the app once more.
      for (const name of statusNames) {
        const check = CHECKS[name];
        if (check.kind === 'status' && status !== undefined) tools.set(name, await check.run(root, { status, boot: appReports.get('boot') }));
      }
    });
    if (strays.length > 0) {
      const redactor = await redactorAfter(build instanceof Application ? build : undefined, root, build !== undefined);
      for (const error of strays) warnings.push(`Unhandled failure that belongs to no check: ${describeFailure(error, redactor, root)}`);
      unowned += strays.length;
    }
    const runs = selected.map((name): CheckRun => tools.get(name) ?? { report: appReports.get(name)! });
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

/** A comma list option (`--only=node,boot`); undefined when the option is not given. */
function list(value: unknown): string[] | undefined {
  return typeof value === 'string' ? value.split(',').map((name) => name.trim()).filter(Boolean) : undefined;
}
