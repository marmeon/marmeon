import { describe, expect, it } from 'vitest';
import { commitAnyway, err, ok, type Result } from './index.ts';
import { resultMark } from './result.ts';

describe('ok() and err()', () => {
  it('are plain data: { ok, value } and { ok, error }', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(err({ kind: 'taken', email: 'ada@example.com' })).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
    expect(Object.keys(ok('x'))).toEqual(['ok', 'value']);
    expect(Object.keys(err({ kind: 'missing' }))).toEqual(['ok', 'error']);
  });

  it('makes ok() without a value an Ok of nothing', () => {
    const done = ok();
    expect(done.ok).toBe(true);
    expect(done.value).toBeUndefined();
    expect(JSON.stringify(done)).toBe('{"ok":true}');
  });

  it('marks a result with a symbol that is not enumerable — JSON, spreading and Object.keys never show it', () => {
    const failed = err({ kind: 'duplicate' });
    expect(JSON.stringify(failed)).toBe('{"ok":false,"error":{"kind":"duplicate"}}');
    expect(JSON.stringify(ok({ id: 1 }))).toBe('{"ok":true,"value":{"id":1}}');
    expect(Object.getOwnPropertySymbols(failed)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols({ ...failed })).toEqual([]);
    expect(resultMark(failed)).toBe('err');
    expect(resultMark(ok(1))).toBe('ok');
  });

  it('does not take a look-alike for a result: a payload that happens to say { ok: false } is just data', () => {
    expect(resultMark({ ok: false, error: { kind: 'duplicate' } })).toBeUndefined();
    expect(resultMark(JSON.parse(JSON.stringify(err({ kind: 'duplicate' }))))).toBeUndefined();
    expect(resultMark({ ...err({ kind: 'duplicate' }) })).toBeUndefined();
    expect(resultMark(undefined)).toBeUndefined();
    expect(resultMark('err')).toBeUndefined();
  });
});

describe('commitAnyway()', () => {
  it('marks an err to commit, and still is a plain err in JSON', () => {
    const dropped = commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
    expect(dropped).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
    expect(JSON.stringify(dropped)).toBe('{"ok":false,"error":{"kind":"taken","email":"ada@example.com"}}');
    expect(resultMark(dropped)).toBe('commit');
  });

  it('refuses anything but a marked err at run time too (a cast does not get past it)', () => {
    expect(() => commitAnyway(ok(1) as never)).toThrow('commitAnyway() takes an err(…): it commits a transaction although the callback failed.');
    expect(() => commitAnyway({ ok: false, error: { kind: 'x' } } as never)).toThrow('commitAnyway() takes an err(…)');
  });
});

describe('a Result', () => {
  it('narrows over ok and switches over the error kind', () => {
    const describe = (result: Result<number, { kind: 'missing' } | { kind: 'taken'; email: string }>): string => {
      if (result.ok) return `found ${result.value}`;
      switch (result.error.kind) {
        case 'missing':
          return 'missing';
        case 'taken':
          return `taken: ${result.error.email}`;
      }
    };
    expect(describe(ok(3))).toBe('found 3');
    expect(describe(err({ kind: 'missing' }))).toBe('missing');
    expect(describe(err({ kind: 'taken', email: 'ada@example.com' }))).toBe('taken: ada@example.com');
  });
});
