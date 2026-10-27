import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceProviderClass } from '@marmeon/core';
import { escapesRoot, readStubManifest, recordStubSet, STUB_MANIFEST } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { assignPublishes, LANG_PACKAGE, publishDeclarations, type PackageLang, type PublishingPackage } from '../package-files.ts';
import { show } from '../package-migrations.ts';

/** Where the framework's texts live in an app, and where the published language files go. Fixed: a package does not choose it. */
const TARGET = 'lang/marmeon';
const SET = `${LANG_PACKAGE}:stubs/lang`;

/** An installed direct dependency of the app. */
export type Installed = PublishingPackage & { readonly name: string; readonly json: { readonly name?: unknown; readonly version?: unknown } };

/** The packages of the app that declare language files: the files, or why they cannot be read. */
export interface LangPackages {
  readonly found: Map<string, { readonly pkg: Installed; readonly lang: PackageLang }>;
  readonly errors: Map<string, string>;
  readonly warnings: string[];
}

/** Reads `static publishes` of `providers` for `installed`, assigned in one pass over all of them. */
export async function readLangPackages(providers: readonly ServiceProviderClass[], installed: readonly Installed[]): Promise<LangPackages> {
  const found: LangPackages['found'] = new Map();
  const errors = new Map<string, string>();
  const assigned = await assignPublishes(installed, publishDeclarations(providers));
  for (const pkg of installed) {
    const read = assigned.results.get(pkg);
    if (read === undefined) continue;
    if (!read.ok) errors.set(pkg.name, read.error.message);
    else if (read.value) found.set(pkg.name, { pkg, lang: read.value });
  }
  return { found, errors, warnings: assigned.warnings };
}

/** How much of a package's language files the app has: those under `lang/marmeon/` by name. */
export function langState(root: string, lang: PackageLang): { present: number; total: number } {
  const present = lang.files.filter((file) => lstatSync(join(root, TARGET, file.name), { throwIfNoEntry: false }) !== undefined).length;
  return { present, total: lang.files.length };
}

/** The line the list shows for a package. */
export function describeLang(name: string, state: { present: number; total: number }): string {
  if (state.present === 0) return `${name} — not published (${state.total})`;
  if (state.present === state.total) return `${name} — published (${state.total})`;
  return `${name} — partly (${state.present} of ${state.total})`;
}

function versionOf(pkg: Installed): string | undefined {
  return typeof pkg.json.version === 'string' ? pkg.json.version : undefined;
}

/** The version that last recorded `path` in the manifest, for the line that says a file is the app's. */
function recordedVersion(manifest: { readonly sets: Readonly<Record<string, { readonly version: string; readonly files: Readonly<Record<string, unknown>> }>> } | undefined, path: string): string | undefined {
  return manifest?.sets[SET]?.files[path] === undefined ? undefined : manifest.sets[SET]!.version;
}

/**
 * Writes the language files of `lang` into `lang/marmeon/` and records them in `marmeon-stubs.json`. Everything is checked before
 * the first write, so a refusal leaves the app as it was: no path may lead out of the project, `lang/marmeon` must be a real
 * directory, the manifest must be readable, and with `--force` no target may be a link. A file that is there stays unless
 * `force`; files are created with `wx`, which follows no link. Returns the exit code.
 */
export function writeLang(input: CommandInput, pkg: Installed, lang: PackageLang, force: boolean): number {
  const { root, output } = input;
  const refuse = (message: string) => {
    output.error(`${message} Nothing was written.`);
    return 1;
  };
  const targets = lang.files.map((file) => `${TARGET}/${file.name}`);

  for (const path of ['lang', TARGET, ...targets, STUB_MANIFEST]) {
    if (escapesRoot(root, path) !== undefined) return refuse(`${path} leads out of the project, and publish would write through it. Replace the link with a real file or directory, then run publish again.`);
  }
  // A link is no directory for lstat: `lang` and `lang/marmeon` have to be real ones, or not there yet.
  for (const path of ['lang', TARGET]) {
    const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (entry !== undefined && !entry.isDirectory()) return refuse(`${path} is not a directory.`);
  }
  const manifest = readStubManifest(root);
  if (!manifest.ok) return refuse(manifest.error.message);

  const there = new Set<string>();
  for (const [index, file] of lang.files.entries()) {
    const entry = lstatSync(join(root, targets[index]!), { throwIfNoEntry: false });
    if (entry === undefined) continue;
    there.add(file.name);
    // A hard link to a file outside the app has no path to check: --force would write into that file as well.
    if (force && (!entry.isFile() || entry.nlink > 1)) return refuse(`${targets[index]} is a link, a hard link or no regular file, and --force would write through it. Remove it, then run publish again.`);
  }

  mkdirSync(join(root, TARGET), { recursive: true });
  const written: string[] = [];
  for (const [index, file] of lang.files.entries()) {
    const path = targets[index]!;
    if (there.has(file.name) && !force) {
      const version = recordedVersion(manifest.value, path);
      output.line(`${path} is there — skipped (yours${version === undefined ? '' : ` since ${LANG_PACKAGE} ${version}`})`);
      continue;
    }
    if (there.has(file.name)) {
      // O_NOFOLLOW: a link put in place after the check is refused, not written through.
      const fd = openSync(join(root, path), constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
      try {
        writeSync(fd, file.contents);
      } finally {
        closeSync(fd);
      }
      output.success(`Replaced ${path}`);
    } else {
      writeFileSync(join(root, path), file.contents, { flag: 'wx' });
      output.success(`Created ${path}`);
    }
    written.push(path);
  }
  if (written.length === 0) {
    output.success(`Nothing to publish — every language file of ${LANG_PACKAGE} is in your app`);
    return 0;
  }

  // `recordStubSet` replaces the whole set, so the files recorded before stay in it as long as they still lie in the app, with the hash they were written with.
  // The set has one version: the newest run names it for all of its files.
  const kept = Object.entries(manifest.value?.sets[SET]?.files ?? {})
    .filter(([path]) => !written.includes(path) && lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true)
    .map(([path, entry]) => ({ path, stub: entry.stub, sha256: entry.sha256 }));
  const version = versionOf(pkg);
  const recorded =
    version === undefined
      ? { ok: false as const, error: { message: `The package.json of ${LANG_PACKAGE} has no version.` } }
      : recordStubSet(root, SET, {
          package: LANG_PACKAGE,
          version,
          files: [...kept, ...written.map((path) => ({ path, stub: `stubs/lang/${path.slice(TARGET.length + 1)}` }))],
        });
  if (recorded.ok) output.success(`Recorded the files in ${STUB_MANIFEST}`);
  else output.warn(recorded.error.message);
  output.line("The framework's texts are yours now: change what you need, delete what you keep as it is.");
  return 0;
}

/** The files of a package of the app that has none to publish, named for a message. */
export const noLang = (name: string) => `${show(name)} ships no language files.`;

