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
});
