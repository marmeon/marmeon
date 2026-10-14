import type { Session } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTOR_CHANGE_MAX_AGE, secondFactorProvenWithin } from './proof.ts';

const NOW = 1_800_000_000;

function session(value: unknown, started = true): Session {
  return { started, get: (key: string) => (key === '_auth_two_factor_at' ? value : undefined) } as unknown as Session;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('secondFactorProvenWithin()', () => {
  it('counts a factor proven now and up to the limit, and not a second later', () => {
    expect(FACTOR_CHANGE_MAX_AGE).toBe(900);
    expect(secondFactorProvenWithin(session(NOW), 900)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW - 900), 900)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW - 901), 900)).toBe(false);
  });

  it('counts a missing, malformed or future time as not proven', () => {
    for (const value of [undefined, null, 'now', String(NOW), Number.NaN, Infinity, NOW + 1, {}]) expect(secondFactorProvenWithin(session(value), 900), String(value)).toBe(false);
  });

  it('reads nothing from a session that has not started', () => {
    expect(secondFactorProvenWithin(session(NOW, false), 900)).toBe(false);
  });
});
