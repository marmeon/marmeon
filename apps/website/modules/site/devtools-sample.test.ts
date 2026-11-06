import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVTOOLS_BAR_TABS, DEVTOOLS_PAGES, REDACTED, sampleValues } from './devtools-sample.ts';

const devtools = resolve(import.meta.dirname, '../../../../packages/devtools/src');
const read = (file: string) => readFileSync(resolve(devtools, file), 'utf8');
const layout = read('pages/layout.ts');
const rows = read('pages/rows.ts');
const bar = read('client/bar.ts');
const entry = read('entry.ts');

/** The text between the braces/brackets of the declaration `pattern` matches — fails when the source changed its shape. */
function block(source: string, pattern: RegExp, name: string): string {
  const found = pattern.exec(source)?.[1];
  if (found === undefined) throw new Error(`${name} not found: the devtools' source changed its shape`);
  return found;
}

const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
const pairs = (text: string) => [...text.matchAll(/(\w+):\s*'([^']*)'/g)].map((match) => [match[1]!, match[2]!] as const);

const labels = pairs(block(bar, /const LABELS[^=]*=\s*\{([^}]*)\}/, 'LABELS')).map(([, label]) => label);
const titles = new Map(pairs(block(layout, /export const TITLES[^=]*=\s*\{([^}]*)\}/, 'TITLES')));
const navTypes = quoted(block(layout, /const NAV_TYPES[^=]*=\s*\[([^\]]*)\]/, 'NAV_TYPES'));
const headers = new Map(
  [...block(rows, /const HEADERS[^=]*=\s*\{([\s\S]*?)\n\};/, 'HEADERS').matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((match) => [match[1]!, quoted(match[2]!)] as const),
);

function isSubsequence(wanted: readonly string[], of: readonly string[]): boolean {
  let at = 0;
  for (const item of of) if (item === wanted[at]) at += 1;
  return at === wanted.length;
}

describe('devtools sample data', () => {
  it('lists the pages in the navigation order of the devtools', () => {
    const navigation = navTypes.map((type) => titles.get(type));
    expect(DEVTOOLS_PAGES.map((page) => page.name)).toEqual(['Requests', 'Queries', 'Jobs', 'Mails', 'Logs', 'Exceptions']);
    expect(isSubsequence(DEVTOOLS_PAGES.map((page) => page.name), navigation as string[])).toBe(true);
  });

  it('lists the bar tabs as the bar labels them, in order', () => {
    expect(DEVTOOLS_BAR_TABS.map((tab) => tab.name)).toEqual(labels);
    expect(labels).toHaveLength(6);
  });

  it('uses the columns of the real lists, in their order', () => {
    for (const page of DEVTOOLS_PAGES) {
      const type = [...titles].find(([, title]) => title === page.name)?.[0];
      expect(type, page.name).toBeDefined();
      expect(isSubsequence(page.columns, headers.get(type!) ?? []), page.name).toBe(true);
    }
  });

  it('uses the column names of the bar tables', () => {
    for (const tab of DEVTOOLS_BAR_TABS) for (const block of tab.blocks) for (const column of block.columns ?? []) expect(bar, `${tab.name}: ${column}`).toMatch(new RegExp(`['\`]${column.replace(/[#]/g, '\\$&')}[' (\`]`));
  });

  it('gives every row a cell per column', () => {
    for (const page of DEVTOOLS_PAGES) for (const row of page.rows) expect(row, page.name).toHaveLength(page.columns.length);
    for (const tab of DEVTOOLS_BAR_TABS) for (const part of tab.blocks) for (const row of part.rows ?? []) if (part.columns) expect(row.cells, tab.name).toHaveLength(part.columns.length);
  });

  it('uses the statuses, modes and sections the devtools know', () => {
    const jobStatus = quoted(block(entry, /readonly status: ((?:'[a-z]+' \| )+'[a-z]+');\n\s*\/\*\* `static job`/, 'JobEntryContent status'));
    const jobs = DEVTOOLS_PAGES.find((page) => page.name === 'Jobs')!;
    for (const row of jobs.rows) expect(jobStatus).toContain(row[2]);
    const mails = DEVTOOLS_PAGES.find((page) => page.name === 'Mails')!;
    for (const row of mails.rows) expect(['send', 'queue', 'worker']).toContain(row[4]);
    const optimistic = DEVTOOLS_BAR_TABS.find((tab) => tab.name === 'Optimistic')!;
    for (const part of optimistic.blocks) for (const row of part.rows ?? []) expect(['shown', 'committed', 'replaced by the server', 'rolled back']).toContain(row.cells[2]);
    for (const state of ['replaced by the server', 'rolled back']) expect(bar).toContain(`'${state}'`);
    for (const heading of DEVTOOLS_BAR_TABS.flatMap((tab) => tab.blocks.map((part) => part.heading)).filter((h) => h && !h.startsWith('Page'))) {
      expect(bar, heading).toMatch(new RegExp(`['\`]${heading!.replace(/ \(\d+\)$/, '')}[' (\`]`));
    }
  });

  it('names the live island of the landing page', () => {
    const layers = DEVTOOLS_BAR_TABS.find((tab) => tab.name === 'Layers & regions')!;
    const text = JSON.stringify(layers);
    expect(text).toContain('/islands/render-clock');
    expect(text).toContain('site/islands/RenderClock');
  });

  it('holds nothing a secret scan looks for', () => {
    for (const value of sampleValues()) expect(value).not.toMatch(/password|secret|token=|bearer|cookie=|app_key|https?:\/\//i);
  });

  it('shows a redacted value exactly as the redactor does, and only where its key is on the redactor list', () => {
    const redacted = sampleValues().filter((value) => value.includes('redacted'));
    expect(redacted.length).toBeGreaterThan(0);
    for (const value of redacted) {
      expect(value).toContain(REDACTED);
      expect(value).toMatch(/session_id\s*(=|)\s*'?\[redacted\]/);
    }
    expect(REDACTED).toBe('[redacted]');
  });
});
