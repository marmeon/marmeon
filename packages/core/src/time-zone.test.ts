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
    expect(canonicalTimeZone('Etc/GMT+1')).toBe('Etc/GMT+1');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
  });

  it('refuses a timestamp or an annotated one, which Temporal would read as an offset or a zone', () => {
    for (const value of ['2026-10-14T05:00:00+01:00', '2026-10-14T05:00:00Z', '2026-10-14T05:00:00[Europe/Berlin]', '2026-10-14T05:00:00+01:00[Europe/Berlin]', '', '1']) {
      expect(canonicalTimeZone(value), value).toBeUndefined();
    }
  });
});
