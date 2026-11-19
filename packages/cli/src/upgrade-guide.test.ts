import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { upgradeGuide } from './framework/upgrade-guide.ts';
import { parseVersion, type Version } from './framework/versions.ts';

const v = (text: string): Version => {
  const version = parseVersion(text);
  if (!version) throw new Error(`not a version: ${text}`);
  return version;
};

const real = readFileSync(new URL('../../../UPGRADING.md', import.meta.url), 'utf8');
const versions = (text: string, from: string, to: string): string[] => upgradeGuide(text, v(from), v(to)).map((section) => section.version.text);

describe('upgradeGuide of the repository UPGRADING.md', () => {
  it.each([
    ['0.4.0', '1.1.0', ['1.0.0', '1.1.0']],
    ['1.0.0', '1.1.0', ['1.1.0']],
    ['1.1.0', '1.1.3', []],
    ['1.1.0-rc.2', '1.1.0', ['1.1.0']],
    ['0.1.3', '1.0.0', ['0.2.0', '0.3.0', '0.4.0', '1.0.0']],
    ['0.4.0', '1.0.0-rc.8', ['1.0.0']],
  ])('from %s to %s gives %j', (from, to, expected) => {
    expect(versions(real, from, to)).toEqual(expected);
  });

  it('reads the same sections from a file with CRLF line ends', () => {
    const crlf = real.replace(/\n/g, '\r\n');
    const [section] = upgradeGuide(crlf, v('1.0.0'), v('1.1.0'));
    expect(upgradeGuide(crlf, v('0.4.0'), v('1.1.0')).map((s) => s.version.text)).toEqual(['1.0.0', '1.1.0']);
    expect(section?.entries.map((e) => e.anchor)).toEqual(upgradeGuide(real, v('1.0.0'), v('1.1.0'))[0]?.entries.map((e) => e.anchor));
    expect(section?.markdown).not.toContain('\r');
  });
});

const page = (body: string): string => `# Upgrading\n\n${body}`;

describe('upgradeGuide edge cases', () => {
  it('reads the headings, entries and text of a section', () => {
    const text = page('## Upgrading to 1.1.0 from 1.0.0\n\n### Group\n\n#### Low: A change\n\nIts text.\n\n## Upgrading to 1.0.0 from 0.4.0\n\n#### High: Old\n');
    const [section] = upgradeGuide(text, v('1.0.0'), v('1.1.0'));
    expect(section).toMatchObject({ version: v('1.1.0'), from: v('1.0.0'), anchor: 'upgrading-to-110-from-100' });
    expect(section?.entries).toEqual([{ impact: 'low', title: 'A change', anchor: 'low-a-change' }]);
    expect(section?.markdown).toBe('## Upgrading to 1.1.0 from 1.0.0\n\n### Group\n\n#### Low: A change\n\nIts text.');
  });

  it.each([
    ['1.1.0', '1.2.0-rc.1', ['1.2.0']],
    ['1.1.0', '1.1.9-rc.1', []],
    ['1.2.0-rc.1', '1.2.0-rc.2', ['1.2.0']],
    ['1.2.0-rc.1', '1.2.0', ['1.2.0']],
    ['1.2.0', '1.2.0-rc.2', []],
  ])('from %s to the candidate %s gives %j', (from, to, expected) => {
    const text = page('## Upgrading to 1.2.0 from 1.1.0\n\n#### Low: x\n');
    expect(versions(text, from, to)).toEqual(expected);
  });

  it('ignores headings inside a fenced code block', () => {
    const text = page('## Upgrading to 1.1.0 from 1.0.0\n\n#### Low: Real\n\n```md\n## Upgrading to 1.2.0 from 1.1.0\n#### High: In a fence\n```\n\n#### Medium: After the fence\n');
    const sections = upgradeGuide(text, v('1.0.0'), v('2.0.0'));
    expect(sections.map((s) => s.version.text)).toEqual(['1.1.0']);
    expect(sections[0]?.entries.map((e) => e.title)).toEqual(['Real', 'After the fence']);
    expect(sections[0]?.markdown).toContain('#### High: In a fence');
  });

  it.each(['## Upgrading to 1.2 from 1.1.0', '## Upgrading to 01.2.0 from 1.1.0', '## Upgrading to 1.2.0 from 1.1', '## upgrading to 1.2.0 from 1.1.0', '### Upgrading to 1.2.0 from 1.1.0', '## Upgrading to 1.2.0-rc.1 from 1.1.0', '## Upgrading to 1.2.0 from 1.1.0 and more'])('does not take %j for a section', (heading) => {
    expect(upgradeGuide(page(`${heading}\n\n#### Low: x\n`), v('1.0.0'), v('2.0.0'))).toEqual([]);
  });

  it('ends a section at the next ## heading, not at a ###', () => {
    const text = page('## Upgrading to 1.2.0 from 1.1.0\n\n### Group\n\n#### High: One\n\n## Notes\n\n#### Low: Not an entry of the release\n');
    const [section] = upgradeGuide(text, v('1.1.0'), v('1.2.0'));
    expect(section?.entries.map((e) => e.title)).toEqual(['One']);
    expect(section?.markdown).not.toContain('Notes');
  });

  it('numbers the anchors of equal headings like the website, across sections', () => {
    const text = page('## Upgrading to 1.2.0 from 1.1.0\n\n#### Low: Same\n\n## Upgrading to 1.1.0 from 1.0.0\n\n#### Low: Same\n');
    const sections = upgradeGuide(text, v('1.0.0'), v('1.2.0'));
    expect(sections.map((s) => s.version.text)).toEqual(['1.1.0', '1.2.0']);
    expect(sections.map((s) => s.entries[0]?.anchor)).toEqual(['low-same-1', 'low-same']);
  });

  it('counts an anchor in a fence out of the numbering', () => {
    const text = page('```\n#### Low: Same\n```\n\n## Upgrading to 1.1.0 from 1.0.0\n\n#### Low: Same\n');
    expect(upgradeGuide(text, v('1.0.0'), v('1.1.0'))[0]?.entries[0]?.anchor).toBe('low-same');
  });

  it('reads the impact of an entry and ignores a heading without one', () => {
    const text = page('## Upgrading to 1.1.0 from 1.0.0\n\n#### High: A\n\n#### Medium (contributors): B\n\n#### Whatever\n\n#### Low: C\n');
    expect(upgradeGuide(text, v('1.0.0'), v('1.1.0'))[0]?.entries.map((e) => [e.impact, e.title])).toEqual([['high', 'A'], ['medium', 'B'], ['low', 'C']]);
  });

  it('returns nothing for a page without sections', () => {
    expect(upgradeGuide('', v('1.0.0'), v('2.0.0'))).toEqual([]);
  });
});
