import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { warmUp, WARM_UP_TIMEOUT } from '../auth/warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

const ROUTE = 'members.import';
const REFUSED = 'Only a text file is accepted, such as a CSV.';

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
  it('reads a CSV in Windows-1252 and in UTF-16LE with a byte order mark, checks each row like a form and flashes the count — the file is not stored', async () => {
    const as = app.actingAs(ada);
    const file = 'name;email\nÄnne;anne@example.com\nBen;not-an-address\n;empty@example.com\n';
    for (const bytes of [windows1252(file), utf16le(file)]) {
      const token = await as.upload(ROUTE, 'file', new File([bytes], 'members.csv', { type: 'text/csv' }));
      await send(as, token).assertRedirect('/members').assertFlashed('toast', { kind: 'info', message: '3 rows read, 2 to correct.' });
    }
    expect(app.storage.disk('uploads').files().filter((key) => key.startsWith('imports/'))).toEqual([]);
  });

  it('answers a file without the columns, or one that breaks a limit of readCsv, with the error at its field — and the token stays usable', async () => {
    const as = app.actingAs(ada);
    const token = await as.upload(ROUTE, 'file', new File([windows1252('title;mail\nx;y\n')], 'members.csv'));
    (await send(as, token)).assertInvalid({ file: 'The first row needs the columns name and email.' });
    (await send(as, token)).assertInvalid({ file: 'The first row needs the columns name and email.' }); // not used up: sent again, the same answer
    const open = await as.upload(ROUTE, 'file', new File([windows1252('name;email\n"Ada;ada@example.com\n')], 'members.csv'));
    (await send(as, open)).assertInvalid({ file: /quote/i });
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

  describe('the template (/members/import-template) — a file made in memory, named with contentDisposition()', () => {
    it('answers the two columns as an attachment with a header-safe name, in ASCII and in UTF-8', async () => {
      const english = await app.actingAs(ada).get('/members/import-template').assertOk();
      expect(english.body).toBe('name,email\r\nAda Lovelace,ada@example.com\r\n');
      expect(Object.fromEntries(english.headers)).toMatchObject({
        'content-type': 'text/csv; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="members-template.csv"; filename*=UTF-8''members-template.csv`,
        'cache-control': 'private, no-store',
      });
      await app.make(UserRepository).updateLocale(ada.id, 'de');
      const german = await app.actingAs(ada).get('/members/import-template').assertOk();
      expect(german.headers.get('content-disposition')).toBe(
        `attachment; filename="Mitglieder-Vorlage-f_r-_bernahme.csv"; filename*=UTF-8''Mitglieder-Vorlage-f%C3%BCr-%C3%9Cbernahme.csv`,
      );
    });

    it('is for the people who may import: another member gets a 403', async () => {
      await app.actingAs(alan).get('/members/import-template').assertForbidden();
    });
  });

  describe('the import over two requests: the preview keeps the file, the confirmation finds it again', () => {
    const CSV = 'name;email\nAnne;anne@example.com\nBen;not-an-address\n';
    const confirm = (as: TestApp, id: string) => as.expectingJson().post(`/members/import/${id}`, { json: {} });
    const preview = async (as: TestApp) => {
      const token = await as.upload(ROUTE, 'file', new File([windows1252(CSV)], 'members.csv', { type: 'text/csv' }));
      const response = await send(as, token);
      return { response, id: (response.flashed().find((message) => message.key === 'memberImport')!.data as { id: string }).id };
    };

    it('shows the count, keeps the file for the session, and the confirmation takes it over once and drops the file', async () => {
      const as = app.actingAs(ada);
      const { response, id } = await preview(as);
      response.assertRedirect('/members').assertFlashed('toast', { message: '2 rows read, 1 to correct.' });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      response.assertFlashed('memberImport', { id, rows: 2 });
      expect(response.flashed().find((message) => message.key === 'toast')!.data, 'the toast carries only what it shows').toEqual({ kind: 'info', message: '2 rows read, 1 to correct.' });
      (await confirm(as, id)).assertRedirect('/members').assertFlashed('toast', { kind: 'success', message: '1 row taken over.' });
      expect(app.storage.disk('uploads').files()).toEqual([]);
      (await confirm(as, id)).assertNotFound();
    });

    it('two confirmations at once: one takes the file over, the other finds it gone', async () => {
      const as = app.actingAs(ada);
      const { id } = await preview(as);
      const answers = await Promise.all([confirm(as, id), confirm(as, id)]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([303, 404]);
    });

    it('is found only by the session that sent the file: the same administrator in another session gets a 404, and the file stays', async () => {
      const { id } = await preview(app.actingAs(ada));
      (await confirm(app.actingAs(ada), id)).assertNotFound();
      expect(app.storage.disk('uploads').files()).toHaveLength(1);
    });

    it('is for administrators, and an id that was never kept is a 404', async () => {
      const { id } = await preview(app.actingAs(ada));
      (await confirm(app.actingAs(alan), id)).assertForbidden();
      (await confirm(app.actingAs(ada), '11111111-1111-4111-8111-111111111111')).assertNotFound();
    });
  });

  it('is for administrators: another member gets no upload target and no import', async () => {
    const as = app.actingAs(alan);
    await expect(as.upload(ROUTE, 'file', new File([windows1252('name;email\n')], 'members.csv'))).rejects.toThrow('answered 403');
    await send(as, 'tu_forged.token').assertForbidden();
  });

  it('is throttled like the table’s endpoints (60 a minute per user): the 61st request is a 429', async () => {
    const as = app.actingAs(ada);
    for (let request = 1; request <= 60; request++) expect((await send(as, 'tu_forged.token')).status, `request ${request}`).not.toBe(429);
    expect((await send(as, 'tu_forged.token')).status, 'the 61st request of a minute was served').toBe(429);
  });
});
