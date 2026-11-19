import { headingsOf } from '../anchors.ts';
import { compareVersions, parseVersion, releaseOf, type Version } from './versions.ts';

export interface GuideEntry {
  readonly impact: 'high' | 'medium' | 'low';
  /** Text of the installed package: print it through the command output. */
  readonly title: string;
  readonly anchor: string;
}

/** One `## Upgrading to <version> from <version>` section of `UPGRADING.md`. */
export interface GuideSection {
  readonly version: Version;
  readonly from: Version;
  readonly anchor: string;
  readonly entries: readonly GuideEntry[];
  /** The section as written, heading included. It is text of the installed package: print it through the command output. */
  readonly markdown: string;
}

/** The heading `check-release` enforces. */
const SECTION = /^## Upgrading to (\d+\.\d+\.\d+) from (\d+\.\d+\.\d+)\s*$/;
const ENTRY = /^(High|Medium|Low)(?: \(contributors\))?: (.+)$/;

/**
 * The sections of `text` (the `UPGRADING.md` of the installed package) that an app moving from `from` to `to` has to read, oldest first:
 * those with `from < version <= release of to`, so a candidate (`1.0.0-rc.8`) brings the section of its release. `from` is the lowest installed version.
 */
export function upgradeGuide(text: string, from: Version, to: Version): GuideSection[] {
  const page = text.replace(/\r\n?/g, '\n');
  const lines = page.split('\n');
  const headings = headingsOf(page);
  const last = releaseOf(to);
  const sections: GuideSection[] = [];
  headings.forEach((heading, index) => {
    if (heading.level !== 2) return;
    const match = SECTION.exec(lines[heading.line]!);
    const [version, previous] = [parseVersion(match?.[1] ?? ''), parseVersion(match?.[2] ?? '')];
    if (!version || !previous || compareVersions(version, from) <= 0 || compareVersions(version, last) > 0) return;
    const end = headings.slice(index + 1).find((next) => next.level <= 2)?.line ?? lines.length;
    const entries: GuideEntry[] = [];
    for (const entry of headings.slice(index + 1)) {
      if (entry.line >= end) break;
      const parts = entry.level === 4 ? ENTRY.exec(entry.text) : null;
      if (parts) entries.push({ impact: parts[1]!.toLowerCase() as GuideEntry['impact'], title: parts[2]!, anchor: entry.anchor });
    }
    sections.push({ version, from: previous, anchor: heading.anchor, entries, markdown: lines.slice(heading.line, end).join('\n').trimEnd() });
  });
  return sections.sort((a, b) => compareVersions(a.version, b.version));
}
