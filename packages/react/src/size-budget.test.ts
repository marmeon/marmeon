import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { budgetProblem, limitFor, loweredLimit, lowerLimits, readBudget, RESERVE_KB, SHRINK_KB } from './__fixtures__/bundle.ts';

/**
 * The budget's mechanics (E75, E186 — "the reserve stays"): a limit is the measured size + 0.5 KB at most; `update` lowers it to
 * that after a saving and never raises it; extra cost eats the reserve, which is never refilled. The sizes themselves are
 * `bundle-size.test.ts`'s job (it needs `dist/`); these are plain numbers.
 */
describe('the size budget keeps a reserve of 0.5 KB and only goes down (E186)', () => {
  it('a limit at the measured size + 0.5 holds; more than + 0.6 asks for a lower limit, naming the rule', () => {
    expect(RESERVE_KB).toBe(0.5);
    expect(SHRINK_KB).toBe(0.6);
    expect(budgetProblem('core', 11.07, { limit: 11.57 })).toBeUndefined();
    expect(budgetProblem('core', 11.07, { limit: 11.67 })).toBeUndefined();
    const problem = budgetProblem('core', 11.07, { limit: 11.68 });
    expect(problem).toContain('core shrank to 11.07 KB gzip, more than 0.6 KB under its limit of 11.68 KB');
    expect(problem).toContain('lower it in packages/react/size-budget.json to 11.57');
    expect(problem).toContain('the measured size + 0.5 KB at most');
  });

  it('a size over its limit fails and names the rule — the reserve is never refilled', () => {
    const problem = budgetProblem('web-app', 23.16, { limit: 23.15 });
    expect(problem).toContain('web-app grew to 23.16 KB gzip, over its limit of 23.15 KB');
    expect(problem).toContain('extra cost eats the reserve, which is never refilled');
  });

  it('a ceiling is never asked to go down', () => {
    expect(budgetProblem('everything', 30, { limit: 31.62, ceiling: true })).toBeUndefined();
    expect(loweredLimit(30, { limit: 31.62, ceiling: true })).toBeUndefined();
  });

  it('update lowers a limit after a saving to the measured size + 0.5, to 0.01 KB', () => {
    expect(limitFor(11.07)).toBe(11.57);
    expect(loweredLimit(10.9, { limit: 11.57 })).toBe(11.4);
    expect(loweredLimit(11.06, { limit: 11.57 })).toBe(11.56);
  });

  it('update never raises a limit — extra cost eats the reserve', () => {
    expect(loweredLimit(11.07, { limit: 11.57 })).toBeUndefined();
    expect(loweredLimit(11.3, { limit: 11.57 })).toBeUndefined();
    expect(loweredLimit(11.8, { limit: 11.57 })).toBeUndefined();
  });

  it('lowerLimits writes two decimals in place, keeps the layout and never raises a limit', () => {
    const file = join(tempDir('bespoke-size-budget-'), 'size-budget.json');
    writeFileSync(file, '{\n  "gzipKB": {\n    "core": { "limit": 11.57 },\n    "emptyApp": { "limit": 14.08 }\n  }\n}\n');
    lowerLimits({ core: 11.4, emptyApp: 14.5 }, file);
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text).gzipKB.emptyApp.limit).toBe(14.08); // 14.5 would raise it: it stays
    expect(text).toBe('{\n  "gzipKB": {\n    "core": { "limit": 11.40 },\n    "emptyApp": { "limit": 14.08 }\n  }\n}\n');
  });

  it('every limit in the budget file has two decimals at most and no informational target', () => {
    const budget = readBudget();
    for (const line of [...Object.values(budget.gzipKB), ...Object.values(budget.appsGzipKB)]) {
      expect(Math.round(line.limit * 100) / 100).toBe(line.limit);
      expect(Object.keys(line).filter((key) => key !== 'limit' && key !== 'ceiling')).toEqual([]);
    }
  });
});
