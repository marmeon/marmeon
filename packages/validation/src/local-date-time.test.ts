import type { StandardSchemaV1 } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { rules as r, toLocalDateTime } from './index.ts';

type Result = { value?: unknown; issues?: readonly { message: string; path?: readonly PropertyKey[] }[] };

async function check(rule: StandardSchemaV1, value: unknown): Promise<Result> {
  return (await rule['~standard'].validate(value)) as Result;
}

async function errors(rule: StandardSchemaV1, value: unknown): Promise<Record<string, string[]>> {
  const by: Record<string, string[]> = {};
  for (const issue of (await check(rule, value)).issues ?? []) (by[(issue.path ?? []).map(String).join('.') || '_'] ??= []).push(issue.message);
  return by;
}

const berlin = r.object({ at: r.localDateTime('Europe/Berlin') });
const at = async (rule: StandardSchemaV1, value: unknown) => ((await check(rule, { at: value })).value as { at: string } | undefined)?.at;

describe('r.localDateTime() with a zone', () => {
  it('reads summer and winter time with the offset of the day', async () => {
    expect(await at(berlin, '2026-07-01T14:30')).toBe('2026-07-01T12:30:00.000Z');
    expect(await at(berlin, '2026-01-15T14:30')).toBe('2026-01-15T13:30:00.000Z');
    expect(await at(berlin, '2026-01-15T14:30:45')).toBe('2026-01-15T13:30:45.000Z');
  });

  it('a time the clock skips (spring forward) is read with the offset from before: 02:30 becomes 03:30', async () => {
    expect(await at(berlin, '2026-03-29T02:30')).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
    expect(await at(r.object({ at: r.localDateTime('America/New_York') }), '2026-03-08T02:30')).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
  });

  it('a time the clock shows twice (fall back) is the first of the two: 02:30 is still summer time', async () => {
    expect(await at(berlin, '2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST, not 02:30 CET (01:30Z)
    expect(await at(r.object({ at: r.localDateTime('America/New_York') }), '2026-11-01T01:30')).toBe('2026-11-01T05:30:00.000Z'); // EDT
  });

  it('a zone with an offset and UTC work too', async () => {
    expect(await at(r.object({ at: r.localDateTime('+02:00') }), '2026-01-15T14:30')).toBe('2026-01-15T12:30:00.000Z');
    expect(await at(r.object({ at: r.localDateTime('UTC') }), '2026-01-15T14:30')).toBe('2026-01-15T14:30:00.000Z');
  });

  it('a value in another shape, or a day that does not exist, says "date and time"', async () => {
    const message = { at: ['The at field must be a date and time like 2026-10-07T14:30.'] };
    for (const wrong of ['2026-07-01', '2026-07-01 14:30', '2026-07-01T14:30Z', '2026-07-01T14:30+02:00', '2026-07-01T24:00', '2026-02-30T10:00', 'tomorrow', 5]) {
      expect(await errors(berlin, { at: wrong }), String(wrong)).toEqual(message);
    }
    expect(await errors(berlin, {})).toEqual({ at: ['The at field is required.'] });
    expect(await errors(berlin, { at: '' })).toEqual({ at: ['The at field is required.'] });
  });

  it('an empty field is missing for optional(), nullable() and default()', async () => {
    const form = r.object({ a: r.localDateTime('UTC').optional(), b: r.localDateTime('UTC').nullable() });
    expect(await check(form, { a: '', b: '' })).toEqual({ value: { a: undefined, b: null } });
  });

  it('a zone it does not know is refused when the rule is defined', () => {
    expect(() => r.localDateTime('Europe/Berln')).toThrow(RangeError);
    expect(() => r.localDateTime('2026-01-01T00:00[UTC]')).toThrow(RangeError);
    expect(() => r.localDateTime('')).toThrow(RangeError);
  });

  it('a function gets the request and names the zone; one that names none says "time zone"', async () => {
    const seen: unknown[] = [];
    const rule = r.object({ at: r.localDateTime((request) => (seen.push(request), 'Asia/Tokyo')) });
    expect(await at(rule, '2026-01-15T14:30')).toBe('2026-01-15T05:30:00.000Z');
    expect(seen).toEqual([undefined]);
    expect(await errors(r.object({ at: r.localDateTime(() => undefined) }), { at: '2026-01-15T14:30' })).toEqual({ at: ['The at field must be a time zone such as Europe/Berlin.'] });
    expect(await errors(r.object({ at: r.localDateTime(() => 'Mars/Base') }), { at: '2026-01-15T14:30' })).toEqual({ at: ['The at field must be a time zone such as Europe/Berlin.'] });
  });
});

describe('r.localDateTime({ field })', () => {
  const event = r.object({ time_zone: r.timeZone(), starts_at: r.localDateTime({ field: 'time_zone' }), ends_at: r.localDateTime({ field: 'time_zone' }).optional() });

  it('reads the validated zone of the other field, whichever comes first', async () => {
    expect(await check(event, { time_zone: 'Europe/Berlin', starts_at: '2026-07-01T14:30' })).toEqual({ value: { time_zone: 'Europe/Berlin', starts_at: '2026-07-01T12:30:00.000Z' } });
    expect(await check(event, { starts_at: '2026-01-15T14:30', ends_at: '2026-03-29T02:30', time_zone: 'Europe/Berlin' })).toEqual({
      value: { time_zone: 'Europe/Berlin', starts_at: '2026-01-15T13:30:00.000Z', ends_at: '2026-03-29T01:30:00.000Z' },
    });
  });

  it('a zone that is no zone is the zone field\'s problem; a missing one too', async () => {
    expect(await errors(event, { time_zone: 'Europe/Berln', starts_at: '2026-07-01T14:30' })).toEqual({ time_zone: ['The time zone field must be a time zone such as Europe/Berlin.'] });
    expect(await errors(event, { starts_at: '2026-07-01T14:30' })).toEqual({ time_zone: ['The time zone field is required.'] });
  });

  it('a wrong date and time stays the field\'s own problem and is reported with the others', async () => {
    expect(await errors(event, { time_zone: 'Europe/Berlin', starts_at: 'soon' })).toEqual({ starts_at: ['The starts at field must be a date and time like 2026-10-07T14:30.'] });
    expect(await errors(event, { time_zone: 'nope', starts_at: 'soon' })).toEqual({
      time_zone: ['The time zone field must be a time zone such as Europe/Berlin.'],
      starts_at: ['The starts at field must be a date and time like 2026-10-07T14:30.'],
    });
  });

  it('a zone field of another rule counts too: it may refuse more', async () => {
    const strict = r.object({ time_zone: r.in(['Europe/Berlin', 'Asia/Tokyo']), at: r.localDateTime({ field: 'time_zone' }) });
    expect(await check(strict, { time_zone: 'Asia/Tokyo', at: '2026-01-15T14:30' })).toEqual({ value: { time_zone: 'Asia/Tokyo', at: '2026-01-15T05:30:00.000Z' } });
    expect(await errors(strict, { time_zone: 'UTC', at: '2026-01-15T14:30' })).toEqual({ time_zone: ['The selected time zone is invalid.'] });
  });

  it('a check on the object sees instants, so the order of two times is a comparison (reported at a field)', async () => {
    const ordered = event.custom((value) => value.ends_at === undefined || value.ends_at > value.starts_at, { message: 'The end is before the start.', field: 'ends_at' });
    expect(await check(ordered, { time_zone: 'Europe/Berlin', starts_at: '2026-10-25T02:30', ends_at: '2026-10-25T02:45' })).toMatchObject({ value: { ends_at: '2026-10-25T00:45:00.000Z' } });
    expect(await errors(ordered, { time_zone: 'Europe/Berlin', starts_at: '2026-07-01T14:30', ends_at: '2026-07-01T13:00' })).toEqual({ ends_at: ['The end is before the start.'] });
  });

  it('works asynchronously too (an object with an async rule)', async () => {
    const form = r.object({ time_zone: r.timeZone(), at: r.localDateTime({ field: 'time_zone' }), code: r.string().custom(async () => true) });
    expect(await check(form, { time_zone: 'UTC', at: '2026-01-15T14:30', code: 'x' })).toEqual({ value: { time_zone: 'UTC', at: '2026-01-15T14:30:00.000Z', code: 'x' } });
  });

  it('outside an object next to its zone field it refuses to run, not to guess', async () => {
    await expect(async () => check(r.localDateTime({ field: 'time_zone' }), '2026-01-15T14:30')).rejects.toThrow(/directly in an r\.object/);
    await expect(async () => check(r.object({ list: r.array(r.localDateTime({ field: 'time_zone' })), time_zone: r.timeZone() }), { time_zone: 'UTC', list: ['2026-01-15T14:30'] })).rejects.toThrow(/directly in an r\.object/);
    expect(() => r.object({ at: r.localDateTime({ field: 'time_zone' }) })).toThrow(/has no field 'time_zone'/);
  });
});

describe('the edges of r.localDateTime()', () => {
  it('a leap second and an hour 24 are no times; years 1–9999 only, also after the zone moved the instant', async () => {
    const message = { at: ['The at field must be a date and time like 2026-10-07T14:30.'] };
    for (const wrong of ['2026-07-01T23:59:60', '2026-07-01T24:00:00', '2026-07-01T12:60', '0000-01-01T00:00', '9999-12-31T23:30']) {
      expect(await errors(r.object({ at: r.localDateTime('America/New_York') }), { at: wrong }), wrong).toEqual(message);
    }
    expect(await at(r.object({ at: r.localDateTime('UTC') }), '0001-01-01T00:00')).toBe('0001-01-01T00:00:00.000Z');
    expect(await at(r.object({ at: r.localDateTime('UTC') }), '9999-12-31T23:59:59')).toBe('9999-12-31T23:59:59.000Z');
    expect(await errors(r.object({ at: r.localDateTime('+02:00') }), { at: '0001-01-01T00:30' })).toEqual(message);
    const event = r.object({ time_zone: r.string(), at: r.localDateTime({ field: 'time_zone' }) });
    expect(await errors(event, { time_zone: '+02:00', at: '0001-01-01T00:30' })).toEqual(message);
    expect(await errors(event, { time_zone: 'America/New_York', at: '9999-12-31T23:30' })).toEqual(message);
  });

  it('an optional zone left empty while the time is filled is "required" at the zone', async () => {
    const event = r.object({ time_zone: r.timeZone().optional(), at: r.localDateTime({ field: 'time_zone' }).optional() });
    expect(await errors(event, { time_zone: '', at: '2026-07-01T14:30' })).toEqual({ time_zone: ['The time zone field is required.'] });
    expect(await check(event, {})).toEqual({ value: {} });
  });

  it('the zone field must be one of the object\'s own, and the rule does not go into .when()', () => {
    expect(() => r.object({ at: r.localDateTime({ field: 'constructor' }) })).toThrow(/has no field 'constructor'/);
    expect(() => r.object({ kind: r.string() }).when(() => true, { at: r.localDateTime({ field: 'kind' }) })).toThrow(/directly in an r\.object/);
  });
});

describe('r.timeZone()', () => {
  it('takes named zones, refuses offsets and the rest', async () => {
    const form = r.object({ zone: r.timeZone() });
    for (const zone of ['Europe/Berlin', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/UTC', 'Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'Etc/GMT+0', 'GMT']) expect(await check(form, { zone }), zone).toEqual({ value: { zone } });
    const refused = ['+02:00', '+00:00', 'Z', 'Mars/Olympus', '-0500', '-08:00', 'Etc/GMT+2', 'etc/gmt-3', 'GMT+1', 'Europe/Berln', 'berlin time', '2026-01-01T00:00Z', '2026-01-01T00:00[Europe/Berlin]', '+25:00', 'a/'.repeat(5000), 'Europe/Berlin ', 'Europe/Berlin\n', 'Ünï/Zöne'];
    for (const zone of [...refused, 5]) {
      expect(await errors(form, { zone }), String(zone).slice(0, 20)).toEqual({ zone: [zone === 5 ? 'The zone field must be a string.' : 'The zone field must be a time zone such as Europe/Berlin.'] });
    }
    expect(await errors(form, { zone: '' }), 'a format, like r.email()').toEqual({ zone: ['The zone field must be a time zone such as Europe/Berlin.'] });
  });

  it('spells a name as IANA does, and leaves link names (Asia/Calcutta and Asia/Kolkata) as typed', async () => {
    const form = r.object({ zone: r.timeZone() });
    expect(await check(form, { zone: 'europe/berlin' })).toEqual({ value: { zone: 'Europe/Berlin' } });
    expect(await check(form, { zone: 'EUROPE/BERLIN' })).toEqual({ value: { zone: 'Europe/Berlin' } });
    expect(await check(form, { zone: 'utc' })).toEqual({ value: { zone: 'UTC' } });
    expect(await check(form, { zone: 'asia/kolkata' })).toEqual({ value: { zone: 'Asia/Kolkata' } });
  });

  it('an offset in the zone field errors only at the zone; r.in() may still list one', async () => {
    const event = r.object({ time_zone: r.timeZone(), at: r.localDateTime({ field: 'time_zone' }) });
    expect(await errors(event, { time_zone: '+01:00', at: '2026-07-01T14:30' })).toEqual({ time_zone: ['The time zone field must be a time zone such as Europe/Berlin.'] });
    const listed = r.object({ time_zone: r.in(['+02:00']), at: r.localDateTime({ field: 'time_zone' }) });
    expect(await check(listed, { time_zone: '+02:00', at: '2026-07-01T14:30' })).toEqual({ value: { time_zone: '+02:00', at: '2026-07-01T12:30:00.000Z' } });
  });

  it('gives a zone field of r.localDateTime() the canonical case', async () => {
    const event = r.object({ time_zone: r.timeZone(), at: r.localDateTime({ field: 'time_zone' }) });
    expect(await check(event, { time_zone: 'europe/berlin', at: '2026-07-01T14:30' })).toEqual({ value: { time_zone: 'Europe/Berlin', at: '2026-07-01T12:30:00.000Z' } });
  });
});

describe('toLocalDateTime()', () => {
  it('shows an instant as the field reads it, seconds only when there are some', () => {
    expect(toLocalDateTime('2026-07-01T12:30:00.000Z', 'Europe/Berlin')).toBe('2026-07-01T14:30');
    expect(toLocalDateTime(new Date('2026-01-15T13:30:45Z'), 'Europe/Berlin')).toBe('2026-01-15T14:30:45');
    expect(toLocalDateTime('2026-01-15T14:30:00+01:00', 'Asia/Tokyo')).toBe('2026-01-15T22:30');
  });

  it('goes round: what a form sent comes back to the form (the second 02:30 of fall-back is the one that does not)', async () => {
    for (const local of ['2026-07-01T14:30', '2026-01-15T14:30:45', '2026-10-25T02:30', '2026-03-29T03:30']) {
      const instant = await at(berlin, local);
      expect(toLocalDateTime(instant!, 'Europe/Berlin'), local).toBe(local);
    }
    // The skipped 02:30 comes back as the 03:30 it was read as.
    expect(toLocalDateTime((await at(berlin, '2026-03-29T02:30'))!, 'Europe/Berlin')).toBe('2026-03-29T03:30');
  });

  it('refuses a zone or a point in time it does not know', () => {
    expect(() => toLocalDateTime('2026-07-01T12:30:00Z', 'Europe/Berln')).toThrow(RangeError);
    expect(() => toLocalDateTime('yesterday', 'UTC')).toThrow(RangeError);
    expect(() => toLocalDateTime(new Date('nope'), 'UTC')).toThrow(RangeError);
  });
});
