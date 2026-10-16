import { describe, expect, it } from 'vitest';
import { renderSizeTable } from './__fixtures__/size-table.ts';

describe('the size table', () => {
  it('lists the sizes alone when there is no base', () => {
    expect(renderSizeTable({ core: 11.07, 'web-app': 23.1 })).toBe(
      ['| Scenario | KB gzip |', '| --- | ---: |', '| core | 11.07 |', '| web-app | 23.10 |'].join('\n'),
    );
  });

  it('shows the base, the delta in KB and in percent, signed', () => {
    const table = renderSizeTable({ core: 11.5, emptyApp: 13, table: 16 }, { core: 11, emptyApp: 13, table: 16.4 });
    expect(table.split('\n').slice(2)).toEqual([
      '| core | 11.00 | 11.50 | +0.50 | +4.5 % |',
      '| emptyApp | 13.00 | 13.00 | 0.00 | 0.0 % |',
      '| table | 16.40 | 16.00 | -0.40 | -2.4 % |',
    ]);
  });

  it('marks a scenario the base does not have, and never judges a size', () => {
    const table = renderSizeTable({ core: 100, fresh: 3 }, { core: 10 });
    expect(table).toContain('| core | 10.00 | 100.00 | +90.00 | +900.0 % |');
    expect(table).toContain('| fresh | n/a | 3.00 |  |  |');
    expect(table).not.toMatch(/fail|limit|over/i);
  });

  it('keeps a row the pull request removed, with PR = n/a', () => {
    expect(renderSizeTable({ core: 1 }, { core: 1, gone: 2 })).toContain('| gone | 2.00 | n/a |  |  |');
  });
});
