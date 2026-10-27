/**
 * The exceptions to "a function, constant or type of a stable entry point is used by an app, the docs or the kit" that
 * `pnpm api:check` enforces (`scripts/api.ts`; CONTRIBUTING.md, "The API snapshot"). A key is `<entry> <name>`; `<entry> *` stands for
 * every export of an entry.
 */
import { knownEntries, usageOf, type EntryUsage, type NameUsage } from './api-usage.ts';
import { SHIPPED } from './api-sources.ts';
import { repositoryFiles } from './check-source.ts';
import type { SourceFile } from './source-files.ts';

/** Exports that stay public although no app code calls them. Each says why; nothing else belongs here. */
export const EXPORT_EXCEPTIONS: Readonly<Record<string, string>> = {
  '@marmeon/http/client/adapter *': 'the contract of a client adapter: an adapter for another UI library calls it',
  '@marmeon/core/dev hostAllowed': 'for a development middleware of your own: it answers whether a request is for one of the allowed hosts',
};

export interface ExportLists {
  /** Exports that stay public on purpose, each with its reason; keys also `<entry> *`. */
  readonly exceptions: Readonly<Record<string, string>>;
}

const EXPORT_LISTS: ExportLists = { exceptions: EXPORT_EXCEPTIONS };

/** Names the rule leaves alone: an app catches an error, writes a config and registers a provider without naming them in a call. */
const EXEMPT_NAME = /(?:Error|Config|ServiceProvider)$/;

/** Whether the rule looks at the export: a function, a constant, or a type no public declaration names. */
function checked(name: NameUsage): boolean {
  if (name.experimental || EXEMPT_NAME.test(name.name)) return false;
  if (name.kind === 'function' || name.kind === 'const' || name.kind === 'enum') return true;
  return name.kind === 'type' && name.namedBy.length === 0 && name.namedHere.length === 0;
}

/**
 * A function, constant or orphan type of a stable entry point that no docs page, app or the kit uses is a problem: it is `@internal`,
 * not exported, or it stands in `lists.exceptions` with the reason an app needs it. So is one that only other framework packages
 * use. Not checked: classes (the members rule covers them), re-exports, `@experimental` exports, names ending in `Error`,
 * `Config` or `ServiceProvider`, and types a public declaration names. A line of `lists.exceptions` that matches no problem any more is a
 * problem too, so the line gets deleted. Needs no build: it reads the checked-in `api.md` files.
 */
export function exportProblems(root: string, files: readonly SourceFile[] = repositoryFiles(root), lists: ExportLists = EXPORT_LISTS): string[] {
  const covers = (line: string, entry: string, name: string) => line === `${entry} ${name}` || line === `${entry} *`;
  const cache = new Map<string, EntryUsage | undefined>();
  const usage = (entry: string) => (cache.has(entry) ? cache.get(entry) : cache.set(entry, usageOf(entry, root, files)).get(entry));
  /** A docs page, an app (tests included) or the kit uses the name — through the entry that exports it or through one that re-exports it. */
  const usedByApp = (name: NameUsage): boolean => {
    const direct = (use: NameUsage) => use.docs.length > 0 || use.mentioned.length > 0 || use.apps.length > 0 || use.kit.length > 0 || use.tests.some((path) => !path.startsWith('packages/') || SHIPPED.test(path));
    return direct(name) || name.reexportedBy.some((entry) => usage(entry)?.names.some((other) => other.name === name.name && direct(other)));
  };
  const problems: string[] = [];
  const hits: { entry: string; name: string }[] = [];
  for (const entry of knownEntries(root)) {
    for (const name of usage(entry)?.names ?? []) {
      if (!checked(name)) continue;
      if (usedByApp(name)) continue;
      hits.push({ entry, name: name.name });
      const key = `${entry} ${name.name}`;
      if (Object.keys(lists.exceptions).some((line) => covers(line, entry, name.name))) continue;
      const framework = Object.keys(name.siblings).length > 0 || Object.keys(name.launchers).length > 0;
      problems.push(
        framework
          ? `${key} is used only by other framework packages — mark it @internal (they may still call it), or list it in EXPORT_EXCEPTIONS with the reason an app needs it; see \`pnpm api:usage ${entry} --files\``
          : `${key} is used nowhere outside the framework (docs, apps, the kit) — mark it @internal, stop exporting it, or list it in EXPORT_EXCEPTIONS with the reason an app needs it; see \`pnpm api:usage ${entry} --files\``,
      );
    }
  }
  for (const line of Object.keys(lists.exceptions)) {
    if (!hits.some((hit) => covers(line, hit.entry, hit.name))) problems.push(`${line} is listed in EXPORT_EXCEPTIONS but follows the rule — delete the line`);
  }
  return problems;
}
