import { Storage } from '@marmeon/storage';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

describe('the app\'s public disk answers a Range request', () => {
  it('a ranged GET of a public file is a 206 with the slice, and one past the end is a 416', async () => {
    const app = await createTestApp(application, { storage: 'real' });
    const disk = app.make(Storage).disk('public');
    const key = `range-check-${crypto.randomUUID()}.mp4`;
    try {
      await disk.put(key, '0123456789');
      const url = disk.url(key);
      const part = await app.withHeaders({ range: 'bytes=2-4' }).get(url).assertStatus(206);
      part.assertHeader('content-range', 'bytes 2-4/10').assertHeader('content-length', '3').assertHeader('accept-ranges', 'bytes').assertHeader('x-content-type-options', 'nosniff');
      expect(new TextDecoder().decode(part.bytes())).toBe('234');
      const beyond = await app.withHeaders({ range: 'bytes=10-' }).get(url).assertStatus(416);
      beyond.assertHeader('content-range', 'bytes */10').assertHeader('cache-control', 'no-store');
    } finally {
      await disk.delete(key);
      await app.close();
    }
  });
});
