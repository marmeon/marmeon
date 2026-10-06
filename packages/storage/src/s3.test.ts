import { randomUUID } from 'node:crypto';
import { TestClock } from '@bespokecore/core';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureBucket, S3_ENDPOINT, s3Options } from './__fixtures__/disks.ts';
import { S3Disk } from './drivers/s3.ts';

/** Against the S3-compatible test container (`docker compose up -d`, `pnpm test:s3`). */
describe.skipIf(!S3_ENDPOINT)('the s3 disk against an S3-compatible store', () => {
  const clock = new TestClock();
  const disks: S3Disk[] = [];
  const make = async (visibility: 'public' | 'private' = 'private') => {
    await ensureBucket();
    const disk = new S3Disk({ name: 'files', options: s3Options(`t-${randomUUID()}`, visibility), visibility, clock });
    disks.push(disk);
    return disk;
  };
  afterAll(async () => {
    for (const disk of disks) await disk.close();
  });

  it('temporaryUrl(): a presigned GET — a download unless a raster image', async () => {
    const disk = await make();
    await disk.put('exports/7.json', '{"a":1}');
    await disk.put('avatars/7.png', new Uint8Array([0x89, 0x50]));
    const json = await fetch(await disk.temporaryUrl('exports/7.json', { expiresIn: 60, filename: 'my-data.json' }));
    expect(json.status).toBe(200);
    expect(await json.text()).toBe('{"a":1}');
    expect(json.headers.get('content-disposition')).toBe(`attachment; filename="my-data.json"; filename*=UTF-8''my-data.json`);
    const png = await fetch(await disk.temporaryUrl('avatars/7.png', { expiresIn: 60 }));
    expect([png.status, png.headers.get('content-type'), png.headers.get('content-disposition')?.split(';')[0]]).toEqual([200, 'image/png', 'inline']);
  });

  it('counter-check: the presigned URL names the type by the file name — never the stored type (HTML stored under .png stays an image)', async () => {
    const disk = await make();
    await disk.put('avatars/8.png', '<script>alert(1)</script>', { contentType: 'text/html' });
    const shown = await fetch(await disk.temporaryUrl('avatars/8.png', { expiresIn: 60 }));
    await shown.arrayBuffer();
    expect([shown.headers.get('content-type'), shown.headers.get('content-disposition')?.split(';')[0]]).toEqual(['image/png', 'inline']);
  });

  it('counter-check: a presigned URL with an altered signature, key, expiry or disposition — 403 from the store', async () => {
    const disk = await make();
    await disk.put('exports/7.json', 'mine');
    await disk.put('exports/8.json', 'someone else’s');
    const url = new URL(await disk.temporaryUrl('exports/7.json', { expiresIn: 60 }));
    const tampered = async (change: (url: URL) => void) => {
      const copy = new URL(url);
      change(copy);
      return (await fetch(copy)).status;
    };
    expect(await tampered(() => {})).toBe(200);
    const signature = url.searchParams.get('X-Amz-Signature')!;
    expect(await tampered((u) => u.searchParams.set('X-Amz-Signature', `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`))).toBe(403);
    expect(await tampered((u) => (u.pathname = u.pathname.replace('7.json', '8.json')))).toBe(403);
    expect(await tampered((u) => u.searchParams.set('X-Amz-Expires', '604800'))).toBe(403);
    expect(await tampered((u) => u.searchParams.set('response-content-disposition', 'inline'))).toBe(403);
    expect([400, 403]).toContain(await tampered((u) => u.searchParams.delete('X-Amz-Signature'))); // a malformed presign: 400
  });

  it('counter-check: an expired presigned URL — 403 (signed by the app clock)', async () => {
    const disk = await make();
    await disk.put('a.txt', 'a');
    clock.travelTo(Date.now() - 2 * 3600_000);
    try {
      const url = await disk.temporaryUrl('a.txt', { expiresIn: 60 });
      expect((await fetch(url)).status).toBe(403);
    } finally {
      clock.travelTo(Date.now());
    }
  });

  it('the store refuses requests without the disk’s credentials', async () => {
    const disk = await make();
    await disk.put('a.txt', 'a');
    const unsigned = new URL(await disk.temporaryUrl('a.txt', { expiresIn: 60 }));
    expect((await fetch(`${unsigned.origin}${unsigned.pathname}`)).status).toBe(403);
  });

  it('url() of a public disk: endpoint/bucket/root/key', async () => {
    const disk = await make('public');
    expect(disk.url('avatars/ä.png')).toMatch(new RegExp(`^${S3_ENDPOINT}/bespoke-test/t-[0-9a-f-]+/avatars/%C3%A4\\.png$`));
  });
});
