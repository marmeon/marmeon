import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Application } from '@marmeon/core';
import { staticNames } from '@marmeon/core/internal';
import { appListedProviders } from './app-providers.ts';
import type { CommandInput } from './command.ts';

export interface UnlistedClass {
  /** Path relative to the app root. */
  readonly file: string;
  readonly className: string;
  readonly key: 'job' | 'notification';
  readonly value: string;
}

/** The module field that lists the classes with a `static <key>`. */
const LISTS = { job: 'jobs', notification: 'notifications' } as const;

/** What the check reads of an app. */
export type UnlistedApp = Pick<Application, 'modules' | 'providers' | 'definition'>;

/**
 * Classes under `<root>/modules` with a literal `static job` or `static notification` that no module lists. A job also counts
 * as listed when a provider the app lists itself (its `providers` or a module's) lists it in its `static jobs`. A provider
 * that only discovery adds does not count. The files are parsed, never imported: nothing in them runs, and nothing is
 * written.
 */
export function unlistedClasses(root: string, app: UnlistedApp): UnlistedClass[] {
  const listed = {
    job: new Set<string>(),
    notification: new Set<string>(),
  };
  for (const module of app.modules) {
    for (const key of ['job', 'notification'] as const) {
      const classes = (module as unknown as Record<string, readonly Record<string, unknown>[] | undefined>)[LISTS[key]] ?? [];
      for (const listedClass of classes) if (typeof listedClass?.[key] === 'string') listed[key].add(listedClass[key]);
    }
  }
  for (const provider of appListedProviders(app)) {
    const jobs = (provider as unknown as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) continue;
    for (const entry of jobs) if (typeof entry === 'function' && typeof (entry as { job?: unknown }).job === 'string') listed.job.add((entry as unknown as { job: string }).job);
  }
  const found: UnlistedClass[] = [];
  for (const path of sourceFiles(join(root, 'modules'))) {
    const source = readFileSync(path, 'utf8');
    for (const name of staticNames(source, path, ['job', 'notification'])) {
      const key = name.key as 'job' | 'notification';
      if (!listed[key].has(name.value)) found.push({ file: relative(root, path), className: name.className, key, value: name.value });
    }
  }
  return found;
}

/** Prints one warning per unlisted class; returns how many there were. */
export function warnUnlisted(output: CommandInput['output'], root: string, app: UnlistedApp): number {
  const unlisted = unlistedClasses(root, app);
  for (const { file, className, key, value } of unlisted) {
    output.warn(
      key === 'job'
        ? `${file}: ${className} (static job '${value}') is in no module's jobs — dispatching it fails. Add it to jobs in its module's index.ts.`
        : `${file}: ${className} (static notification '${value}') is in no module's notifications — sending it fails. Add it to notifications in its module's index.ts.`,
    );
  }
  return unlisted.length;
}

function sourceFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return []; // no modules/ directory
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__' || entry.name.startsWith('.')) continue;
      files.push(...sourceFiles(join(directory, entry.name)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|type-test)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}
