import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application } from '@marmeon/core';
import { loadDiscoveredPackages } from '@marmeon/core/internal';
import { CommandRegistry, type CommandClass } from '../command.ts';
import { appRedactor, loadApplication } from '../load.ts';
import { readMigrationStatus, type MigrationStatus } from '../migration-status.ts';
import { describeFailure } from './app.ts';
import { reportOf, unrunReport, type CheckProblem, type CheckReport } from './report.ts';
import type { CheckRun } from './tools.ts';

const DOCS = 'docs/migrations.md#running-migrations';

/** How long `migrate:status` has, the same as an app check. */
const TIMEOUT_MS = 60_000;

/** What the build app's registry holds: an `Error` when the app did not load; `registry: false` without a `CommandRegistry` (no provider of the CLI). */
export type StatusCommand = Error | { readonly registry: false } | { readonly registry: true; readonly command: CommandClass | undefined };

/** Reads `migrate:status` from the build app's registry. Taken before the app is shut down, which is when its answer is certain. */
export function statusCommandOf(build: Application | Error): StatusCommand {
  if (build instanceof Error) return build;
  return build.container.has(CommandRegistry) ? { registry: true, command: build.container.make(CommandRegistry).get('migrate:status') } : { registry: false };
}

/** What the check is told by `marmeon doctor`: the command of the build app, and the report of `boot` when that ran. */
export interface MigrationsInput {
  readonly status: StatusCommand;
  readonly boot?: CheckReport;
}

/** Whether `command` is the one `DatabaseServiceProvider` of the app's own copy of @marmeon/database brings: an app may register any class under any name. */
async function isOwnStatus(root: string, command: CommandClass): Promise<boolean> {
  try {
    const entry = createRequire(join(root, 'package.json')).resolve('@marmeon/database');
    const provider = ((await import(pathToFileURL(entry).href)) as Record<string, { commands?: readonly CommandClass[] } | undefined>).DatabaseServiceProvider;
    return provider?.commands?.includes(command) === true;
  } catch {
    return false;
  }
}

/** The signals that end `marmeon doctor`: the child it waits for leads a process group of its own, so none of them reaches it. */
const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * The `migrations` check of `marmeon doctor`: one problem for each migration the database has not run, from `marmeon migrate:status`
 * in a child process. It is `skipped` only when the app did not load while `boot` runs (that check says why) or when the app has no
 * database package (not discovered, and its command is not the database's own). It is an `error`, never `failed`, when the app did
 * not load and `boot` does not run, the packages cannot be discovered, the command is not registered or is not the database's own,
 * or the command does not answer (it fails, cannot start, runs out of time, prints what this version does not read, or is
 * interrupted with doctor). See docs/check.md#the-environment-marmeon-doctor.
 */
export async function migrationsCheck(root: string, { status, boot }: MigrationsInput): Promise<CheckRun> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const unrun = (state: 'skipped' | 'error', reason: string): CheckRun => ({ report: unrunReport('migrations', state, reason, ms()) });
  if (boot !== undefined && boot.status !== 'passed') return unrun('skipped', 'the app did not load');
  const redactor = await appRedactor(root);
  if (status instanceof Error) return unrun('error', `the app did not load: ${describeFailure(status, redactor, root)}`);
  if (!status.registry) return unrun('error', "the command migrate:status is not registered: add `CliServiceProvider` of marmeon to the app's providers");
  // The registry decides first, as for the other checks of the database: a package that lies out of reach of discovery may still be registered.
  if (status.command === undefined || !(await isOwnStatus(root, status.command))) {
    let packages: readonly string[];
    try {
      packages = (await loadDiscoveredPackages({ root })).packages;
    } catch (error) {
      return unrun('error', `the packages of the app could not be discovered: ${describeFailure(error, redactor, root)}`);
    }
    if (!packages.includes('@marmeon/database')) return unrun('skipped', '@marmeon/database is not installed');
    return unrun('error', "the command migrate:status is not registered: add `DatabaseServiceProvider` of @marmeon/database to the app's providers");
  }
  // The child dispatches by name after the providers booted, and a `boot()` can bind another registry: the registry of the booted app must hold the database's command too.
  // This guards against a command that shadows the database's by accident. App code that sets out to deceive doctor runs with the app's rights anyway.
  const booted = await loadApplication(root, 'run');
  if (booted instanceof Error) return unrun('error', `the app did not load: ${describeFailure(booted, redactor, root)}`);
  let bootedCommand: CommandClass | undefined;
  try {
    bootedCommand = booted.container.has(CommandRegistry) ? booted.container.make(CommandRegistry).get('migrate:status') : undefined;
  } finally {
    await booted.shutdown().catch(() => undefined);
  }
  if (bootedCommand === undefined || !(await isOwnStatus(root, bootedCommand))) {
    return unrun('error', "the command migrate:status is not registered: add `DatabaseServiceProvider` of @marmeon/database to the app's providers");
  }
  // The child has its own process group: a signal to doctor must stop it, or it outlives the run.
  const interrupted = new AbortController();
  // `on`, not `once`: a second signal while the child is stopped (one Ctrl-C can deliver two) must not take the default action and end doctor with the child orphaned.
  const stop = () => interrupted.abort();
  for (const signal of INTERRUPTS) process.on(signal, stop);
  let read: MigrationStatus;
  try {
    read = await readMigrationStatus(root, { timeoutMs: TIMEOUT_MS, signal: interrupted.signal });
  } catch (error) {
    return unrun('error', `marmeon migrate:status could not be started: ${describeFailure(error, redactor, root)}`);
  } finally {
    for (const signal of INTERRUPTS) process.off(signal, stop);
  }
  if (!read.ok) return unrun('error', describeFailure(new Error(read.reason), redactor, root));
  const problems: CheckProblem[] = [
    ...read.migrations
      .filter((migration) => migration.status === 'pending')
      .map((migration): CheckProblem => ({ severity: 'error', message: redactor.text(`${migration.name} (module ${migration.module}) has not run`), fix: 'marmeon migrate', docs: DOCS, rule: 'marmeon(migrations)' })),
    ...read.warnings.map((warning): CheckProblem => ({ severity: 'warning', message: redactor.text(warning), docs: DOCS, rule: 'marmeon(migrations)' })),
  ];
  return { report: reportOf('migrations', problems, ms()) };
}
