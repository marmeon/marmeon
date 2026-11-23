import { Storage } from '@marmeon/storage';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

describe('the app\'s own disk driver', () => {
  it('the scratch disk takes and hands back files, and is private', async () => {
    const app = await createTestApp(application, { storage: 'real' });
    const disk = app.make(Storage).disk('scratch');
    await disk.put('notes/a.txt', 'hello');
    expect(await disk.text('notes/a.txt')).toBe('hello');
    expect(await disk.list()).toEqual(['notes/a.txt']);
    expect(() => (disk as unknown as { url(key: string): string }).url('notes/a.txt')).toThrow(/private/);
    await expect(disk.temporaryUrl('notes/a.txt', { expiresIn: { minutes: 5 } })).resolves.toMatch(/^\/scratch\/scratch\/notes\/a\.txt\?.*signature=/);
    await app.close();
  });

  it('the scratch disk opts in to ranges: a slice, the tail, or unsatisfiable', async () => {
    const app = await createTestApp(application, { storage: 'real' });
    const disk = app.make(Storage).disk('scratch');
    await disk.put('digits.txt', '0123456789');
    const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
    const slice = await disk.open('digits.txt', { range: { start: 2, end: 4 } });
    expect([await text(slice.body), slice.range, slice.acceptsRanges, slice.size]).toEqual(['234', { start: 2, end: 4 }, true, 10]);
    const tail = await disk.open('digits.txt', { range: { last: 3 } });
    expect([await text(tail.body), tail.range]).toEqual(['789', { start: 7, end: 9 }]);
    const past = await disk.open('digits.txt', { range: { start: 10 } });
    expect([await text(past.body), past.range, past.size]).toEqual(['', 'unsatisfiable', 10]);
    expect(await text((await disk.open('digits.txt')).body)).toBe('0123456789');
    await app.close();
  });
});
