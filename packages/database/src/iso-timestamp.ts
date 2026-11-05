const TEXT = /^(\d{4,}-\d\d-\d\d)[ T](\d\d:\d\d)(?::(\d\d)(?:\.(\d+))?)?(?:\+00(?::?00)?)?$/;

/**
 * A timestamp the database returned as text (`2026-10-01 12:00:00.123456+00` from a UTC session, `2026-10-01T12:00:00+00:00` from
 * `to_json`), as the ISO 8601 UTC string both drivers hand out. Read textually, so a year past 9999 survives. `infinity`, `-infinity`
 * and a value that is already UTC (`…Z`) stay as they are, and so does one `Date` cannot read, a BC date among them: it comes back in
 * the text form of the path it came by, not thrown.
 */
export function isoTimestamp(value: string): string {
  if (value === 'infinity' || value === '-infinity' || value.endsWith('Z')) return value;
  const match = TEXT.exec(value);
  if (match) {
    const [, date, time, seconds = '00', fraction = ''] = match;
    return `${date}T${time}:${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
