/**
 * `node scripts/release-notes.ts [version]` — the Markdown release notes of one version on stdout: the `## <version>` section of
 * every package's `CHANGELOG.md`, merged. The same changeset is in every package's changelog and is listed once; entries are
 * grouped by their `### Major/Minor/Patch Changes` heading; the "Updated dependencies" bullets are dropped. The version defaults to
 * the packages' own (the lockstep version). A package without that section is an error (exit 1): the notes would be incomplete.
 *
 * The release workflow passes the output to the draft GitHub Release (CONTRIBUTING.md, "Changesets and releases").
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkPackages } from './packages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The headings Changesets writes, in the order the notes list them. */
const GROUPS = ['Major Changes', 'Minor Changes', 'Patch Changes'] as const;

/** The lines under `## <version>` of a changelog (up to the next `## `), `undefined` when the version has no section. */
function sectionOf(changelog: string, version: string): string[] | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** A section's bullets by group heading; a bullet keeps its continuation lines (indented) and is trimmed at the end. */
function bulletsOf(section: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let group: string[] | undefined;
  let bullet: string[] | undefined;
  // A bullet stays open across blank lines (a multi-paragraph summary); trailing blanks are trimmed when it closes.
  const flush = () => {
    if (bullet && group) group.push(bullet.join('\n').trimEnd());
    bullet = undefined;
  };
  for (const line of section) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      group = groups.get(heading[1]!) ?? [];
      groups.set(heading[1]!, group);
    } else if (line.startsWith('- ')) {
      flush();
      bullet = [line];
    } else if (bullet && (/^\s+\S/.test(line) || line.trim() === '')) bullet.push(line);
    else flush();
  }
  flush();
  return groups;
}

/** The merged notes of `version`; throws when a package's changelog has no section for it. */
export function releaseNotes(repository: string, version: string): string {
  const merged = new Map<string, Set<string>>();
  const missing: string[] = [];
  for (const pkg of frameworkPackages(repository)) {
    const file = join(pkg.dir, 'CHANGELOG.md');
    const section = existsSync(file) ? sectionOf(readFileSync(file, 'utf8'), version) : undefined;
    if (!section) {
      missing.push(pkg.name);
      continue;
    }
    for (const [heading, bullets] of bulletsOf(section)) {
      const entries = merged.get(heading) ?? new Set<string>();
      merged.set(heading, entries);
      for (const bullet of bullets) if (!/^- Updated dependencies\b/.test(bullet)) entries.add(bullet);
    }
  }
  if (missing.length > 0) throw new Error(`no "## ${version}" section in the CHANGELOG.md of ${missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(', ')}`);
  const known = new Set<string>(GROUPS);
  const order = [...GROUPS, ...[...merged.keys()].filter((heading) => !known.has(heading))];
  const blocks = order.filter((heading) => (merged.get(heading)?.size ?? 0) > 0).map((heading) => `### ${heading}\n\n${[...merged.get(heading)!].join('\n')}`);
  if (blocks.length === 0) throw new Error(`the "## ${version}" sections hold no changes`);
  return `${blocks.join('\n\n')}\n`;
}

if (import.meta.main) {
  try {
    const version = process.argv[2] ?? frameworkPackages(root)[0]?.manifest.version;
    if (!version) throw new Error('no version given and no package to read one from');
    process.stdout.write(releaseNotes(root, version));
  } catch (error) {
    console.error(`release-notes: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
