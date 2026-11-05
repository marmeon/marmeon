import { describe, expect, it } from 'vitest';
import { isoTimestamp } from './iso-timestamp.ts';

describe('isoTimestamp', () => {
  it('writes a zone-less (UTC) or offset timestamp as ISO 8601 UTC', () => {
    expect(isoTimestamp('2026-10-01 12:00:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(isoTimestamp('2026-10-01T12:00:00+02:00')).toBe('2026-10-01T10:00:00.000Z');
  });

  it('reads Postgres text in both of its forms, a year past 9999 included', () => {
    expect(isoTimestamp('2026-10-01 12:00:00.123456+00')).toBe('2026-10-01T12:00:00.123Z');
    expect(isoTimestamp('10000-01-01 00:00:00+00')).toBe('10000-01-01T00:00:00.000Z');
    expect(isoTimestamp('10000-01-01T00:00:00+00:00')).toBe('10000-01-01T00:00:00.000Z');
  });

  it('leaves infinity and a UTC value as they are', () => {
    expect(isoTimestamp('infinity')).toBe('infinity');
    expect(isoTimestamp('-infinity')).toBe('-infinity');
    expect(isoTimestamp('2026-10-01T12:00:00.000Z')).toBe('2026-10-01T12:00:00.000Z');
  });

  it('returns a value Date cannot read as it came, instead of throwing', () => {
    expect(isoTimestamp('not a date')).toBe('not a date');
    expect(isoTimestamp('0044-03-15 12:00:00 BC')).toBe('0044-03-15 12:00:00 BC');
  });
});
