import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, isTimeZone } from './time-zone.ts';

describe('time zones', () => {
  it('knows IANA names', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('spells a zone the way a browser formats with it, and refuses an offset', () => {
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('+01:00')).toBeUndefined();
    expect(canonicalTimeZone('Mars/Olympus')).toBeUndefined();
  });
});
