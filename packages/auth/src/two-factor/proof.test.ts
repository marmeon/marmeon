import type { Session } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_GUARD_NAMES, guardNames } from '../guard-names.ts';
import { FACTOR_CHANGE_MAX_AGE_SECONDS, secondFactorProvenWithin } from './proof.ts';

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
    expect(FACTOR_CHANGE_MAX_AGE_SECONDS).toBe(900);
    expect(secondFactorProvenWithin(session(NOW), 900, NOW, APP_GUARD_NAMES)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW - 900), 900, NOW, APP_GUARD_NAMES)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW - 901), 900, NOW, APP_GUARD_NAMES)).toBe(false);
  });

  it('counts a missing, malformed or future time as not proven', () => {
    for (const value of [undefined, null, 'now', String(NOW), Number.NaN, Infinity, NOW + 61, {}]) expect(secondFactorProvenWithin(session(value), 900, NOW, APP_GUARD_NAMES), String(value)).toBe(false);
  });

  it('counts a time up to a minute ahead of the clock, and not a second more', () => {
    expect(secondFactorProvenWithin(session(NOW + 59), 900, NOW, APP_GUARD_NAMES)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW + 60), 900, NOW, APP_GUARD_NAMES)).toBe(true);
    expect(secondFactorProvenWithin(session(NOW + 61), 900, NOW, APP_GUARD_NAMES)).toBe(false);
  });

  it('reads nothing from a session that has not started', () => {
    expect(secondFactorProvenWithin(session(NOW, false), 900, NOW, APP_GUARD_NAMES)).toBe(false);
  });

  it('reads the key of the guard it is asked for, and no other', () => {
    const office = guardNames('office');
    const at = (key: string) => ({ started: true, get: (name: string) => (name === key ? NOW : undefined) }) as unknown as Session;
    expect(secondFactorProvenWithin(at('_auth:office:two_factor_at'), 900, NOW, office)).toBe(true);
    expect(secondFactorProvenWithin(at('_auth:office:two_factor_at'), 900, NOW, APP_GUARD_NAMES), 'the app guard').toBe(false);
    expect(secondFactorProvenWithin(at('_auth_two_factor_at'), 900, NOW, office), 'the proof of the app guard').toBe(false);
    expect(secondFactorProvenWithin(at('_auth:office:two_factor_at'), 900, NOW, guardNames('shop')), 'another guard').toBe(false);
  });
});
