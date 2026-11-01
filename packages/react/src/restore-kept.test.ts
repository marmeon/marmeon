import { describe, expect, it } from 'vitest';
import { restoreKept } from './use-form.ts';

describe('restoreKept', () => {
  it('ignores a __proto__ key in the kept data', () => {
    const kept = JSON.parse('{"__proto__":{"polluted":true},"name":"Grace"}') as Record<string, unknown>;
    const result = restoreKept({ name: 'Ada', age: 3 }, kept);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect('polluted' in result).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(result).toEqual({ name: 'Grace', age: 3 });
  });
});
