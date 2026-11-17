import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKES } from './fakes.ts';

const repo = resolve(import.meta.dirname, '../../../..');
/** The property of `app` each listed fake is: the label, lower-cased, except the one that is named for what it records. */
const property = (fake: string) => (fake === 'Live updates' ? 'broadcast' : fake.toLowerCase());

describe('the fakes the landing lists', () => {
  it('are the rows of the table in docs/fakes.md, in its order', () => {
    const docs = readFileSync(join(repo, 'docs/fakes.md'), 'utf8');
    const rows = [...docs.matchAll(/^\| `app\.([a-z]+)` \|/gm)].map((match) => match[1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(FAKES.map(property)).toEqual(rows);
  });

  it('are the fake getters of TestApp', () => {
    const source = readFileSync(join(repo, 'packages/testing/src/test-app.ts'), 'utf8');
    for (const fake of FAKES) expect(source, fake).toMatch(new RegExp(`^  get ${property(fake)}\\(\\):`, 'm'));
  });
});
