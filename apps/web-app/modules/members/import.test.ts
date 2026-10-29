import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { warmUp, WARM_UP_TIMEOUT } from '../auth/warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

const ROUTE = 'members.import';
const REFUSED = 'Only a text file is accepted, such as a CSV.';
const CSV = 'name;email\nÄnne;anne@example.com\n';

/** A text as bytes in Windows-1252: every character below U+0100 is one byte. */
const windows1252 = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
const utf16le = (text: string) => Uint8Array.from([0xff, 0xfe, ...[...text].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

let app: TestApp;
let ada: User, alan: User;

beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const [first, second] = (await app.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];
  ada = first!;
  alan = second!;
});
afterEach(async () => app?.close());

const send = (as: TestApp, file: unknown) => as.expectingJson().post('/members/import', { json: { file } });

describe('the member import (/members/import) — upload({ text: true }) in the app', () => {
  it('takes a CSV in Windows-1252 and in UTF-16LE with a byte order mark, keeps it on the private uploads disk and flashes its size', async () => {
    const as = app.actingAs(ada);
    for (const bytes of [windows1252(CSV), utf16le(CSV)]) {
      const token = await as.upload(ROUTE, 'file', new File([bytes], 'members.csv', { type: 'text/csv' }));
      await send(as, token).assertRedirect('/members').assertFlashed('toast', { kind: 'success', message: `File received (${bytes.byteLength} bytes).` });
    }
    expect(app.storage.disk('uploads').files()).toHaveLength(2);
    expect(app.storage.disk('uploads').files().every((key) => /^imports\/[a-z2-7]{26}\.bin$/.test(key))).toBe(true);
  });

  it('refuses UTF-16LE HTML with a byte order mark, an SVG and a PNG — 422, nothing stored', async () => {
    const as = app.actingAs(ada);
    const html = utf16le('<!DOCTYPE html><html><script>fetch("/members/_tables/members/export/csv")</script></html>');
    const svg = new TextEncoder().encode('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg onload="alert(1)"/>');
    for (const [name, bytes] of [['members.csv', html], ['logo.csv', svg], ['photo.csv', PNG]] as const) {
      const token = await as.upload(ROUTE, 'file', new File([bytes], name, { type: 'text/csv' }));
      (await send(as, token).assertStatus(422)).assertInvalid({ file: REFUSED });
    }
    // The files wait where they were sent (the private disk, unused); none was stored.
    expect(app.storage.disk('uploads').files().filter((key) => key.startsWith('imports/'))).toEqual([]);
  });

  it('is for administrators: another member gets no upload target and no import', async () => {
    const as = app.actingAs(alan);
    await expect(as.upload(ROUTE, 'file', new File([windows1252(CSV)], 'members.csv'))).rejects.toThrow('answered 403');
    await send(as, 'tu_forged.token').assertForbidden();
  });

  it('is throttled like the table’s endpoints (60 a minute per user): the 61st request is a 429', async () => {
    const as = app.actingAs(ada);
    for (let request = 1; request <= 60; request++) expect((await send(as, 'tu_forged.token')).status, `request ${request}`).not.toBe(429);
    expect((await send(as, 'tu_forged.token')).status, 'the 61st request of a minute was served').toBe(429);
  });
});
