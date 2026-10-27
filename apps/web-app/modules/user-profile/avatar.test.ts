import { Connections } from '@marmeon/database';
import { PAGE_HEADER, PROTOCOL_VERSION, UPLOAD_HEADER } from '@marmeon/http/protocol';
import { UPLOADS_TABLE } from '@marmeon/storage';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserRepository } from '../auth/UserRepository.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { User } from '../auth/users.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** A real PNG: the 8 signature bytes, then whatever — the server goes by the first bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const png = (name = 'me.png') => new File([PNG], name, { type: 'image/png' });
const HTML = '<!DOCTYPE html><html><body><script>fetch("/users/me/export",{method:"POST"})</script></body></html>';
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';

const ROUTE = 'user-profile.avatar.update';
const KEY = /^avatars\/[a-z2-7]{26}\.png$/;

let app: TestApp;
afterEach(async () => app?.close());

async function setUp() {
  app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
  return { ada, as: app.actingAs(ada) };
}

const send = (as: TestApp, user: User, avatar: unknown) => as.expectingJson().put(`/users/${user.public_id}/avatar`, { json: { avatar } });
const uploadRows = async () => (await app.make(Connections).get().selectFrom(UPLOADS_TABLE as never).selectAll().execute()) as { id: string; consumed_at: unknown }[];

describe('the avatar (uploaded ahead, a token in the form, checked by its bytes)', () => {
  it('uploads to the private uploads disk, then the form stores it on the public disk under a random name — shown on the profile and in the list', async () => {
    const { ada, as } = await setUp();
    const token = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    expect(token).toMatch(/^tu_[0-9a-f-]{36}\.[\w-]{43}$/);
    app.storage.disk('uploads').assertCount(1);
    app.storage.disk('public').assertCount(0);

    await send(as, ada, token).assertRedirect(`/users/${ada.public_id}`).assertFlashed('toast', { kind: 'success', message: 'Picture saved.' });
    const path = (await app.make(UserRepository).find(ada.id))!.avatar_path!;
    expect(path).toMatch(KEY);
    app.storage.disk('public').assertExists(path, (bytes) => bytes.join() === PNG.join());
    app.storage.disk('uploads').assertCount(0); // moved, not copied

    // On the profile and in the people list: its public URL — served inline as an image, nosniff.
    const profile = (await as.navigating().get(`/users/${ada.public_id}`).assertOk()).page()!.props as { profile: { avatar: string | null } };
    expect(profile.profile.avatar).toBe(`/storage/${path}`);
    const people = (await as.navigating().get('/people').assertOk()).page()!.props as { people: { data: { publicId: string; avatar: string | null }[] } };
    expect(people.people.data.find((person) => person.publicId === ada.public_id)?.avatar).toBe(`/storage/${path}`);
    (await app.get(`/storage/${path}`).assertOk()).assertHeader('content-type', 'image/png').assertHeader('x-content-type-options', 'nosniff');

    // A new picture replaces the old file.
    const next = await as.upload(ROUTE, 'avatar', png('again.png'), { user: ada.public_id });
    await send(as, ada, next).assertRedirect();
    const replaced = (await app.make(UserRepository).find(ada.id))!.avatar_path!;
    expect(replaced).not.toBe(path);
    app.storage.disk('public').assertMissing(path).assertExists(replaced).assertCount(1);
  });

  it('path traversal in the file name: stored under a random name in avatars/ — the name never becomes a path', async () => {
    const { ada, as } = await setUp();
    for (const name of ['../../.env', '..\\x', '/etc/passwd', 'avatars/../../secret.png']) {
      await send(as, ada, await as.upload(ROUTE, 'avatar', png(name), { user: ada.public_id })).assertRedirect();
      expect((await app.make(UserRepository).find(ada.id))!.avatar_path).toMatch(KEY);
    }
    expect(app.storage.disk('public').files().every((key) => KEY.test(key))).toBe(true);
    app.storage.disk('public').assertCount(1);
  });

  it('type spoofing: HTML named .png with image/png, an SVG with a script, a JS file — 422, nothing stored', async () => {
    const { ada, as } = await setUp();
    const spoofs = [
      new File([HTML], 'cute.png', { type: 'image/png' }),
      new File([SVG], 'logo.svg', { type: 'image/svg+xml' }),
      new File([`﻿  ${HTML}`], 'bom.jpg', { type: 'image/jpeg' }),
      new File(['alert(document.cookie)'], 'x.png', { type: 'image/png' }),
    ];
    for (const file of spoofs) {
      const token = await as.upload(ROUTE, 'avatar', file, { user: ada.public_id });
      (await send(as, ada, token).assertStatus(422)).assertInvalid({ avatar: 'This type of file is not accepted (allowed: PNG, JPG, WEBP).' });
    }
    app.storage.disk('public').assertCount(0);
    expect((await app.make(UserRepository).find(ada.id))!.avatar_path).toBeNull();
  });

  it('a token of another session (another browser of the same user) is refused — 422', async () => {
    const { ada, as } = await setUp();
    const token = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    (await send(app.actingAs(ada), ada, token).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' });
    app.storage.disk('public').assertCount(0);
    await send(as, ada, token).assertRedirect(); // its own session still may
  });

  it('a token works once: the second submit is a 422 — also when both race (one atomic UPDATE decides)', async () => {
    const { ada, as } = await setUp();
    const token = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    await send(as, ada, token).assertRedirect();
    (await send(as, ada, token).assertStatus(422)).assertInvalid({ avatar: 'This file was saved already — choose it again.' });

    const racing = await as.upload(ROUTE, 'avatar', png('race.png'), { user: ada.public_id });
    const answers = await Promise.all([send(as, ada, racing), send(as, ada, racing), send(as, ada, racing)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([303, 422, 422]);
    app.storage.disk('public').assertCount(1);
  });

  it('a lying Content-Length: the stream is cut off after maxBytes (413) — nothing stays on the uploads disk', async () => {
    const { ada, as } = await setUp();
    const target = (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'big.png', size: 1000 } }).assertOk()).json() as { upload: { url: string } };
    let pulled = 0;
    const fifty = 50 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= fifty) return controller.close();
        const chunk = new Uint8Array(64 * 1024);
        chunk.set(PNG);
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream', 'content-length': '1000' }).put(target.upload.url, { body }).assertStatus(413);
    expect(pulled).toBeLessThan(3 * 1024 * 1024); // cut off after 2 MB — not 50 MB read
    app.storage.disk('uploads').assertCount(0);
    // A Content-Length over the limit is refused before a byte is read.
    const second = (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'big.png', size: 10 } }).assertOk()).json() as { upload: { url: string } };
    await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'bytes', 'content-length': '3000000' }).put(second.upload.url, { body: new Uint8Array(10) }).assertStatus(413);
  });

  it('the bytes of a target are sent once: a second PUT (another file) is refused (409) — the first file stays', async () => {
    const { ada, as } = await setUp();
    const target = (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'a.png', size: 20 } }).assertOk()).json() as { token: string; upload: { url: string } };
    const bytes = as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream' });
    await bytes.put(target.upload.url, { body: PNG }).assertOk();
    await bytes.put(target.upload.url, { body: new TextEncoder().encode(HTML) }).assertStatus(409);
    await send(as, ada, target.token).assertRedirect();
    app.storage.disk('public').assertExists((await app.make(UserRepository).find(ada.id))!.avatar_path!, (stored) => stored.join() === PNG.join());
  });

  it('a file the browser says is too large is refused at the target (422) — no row, no target', async () => {
    const { ada, as } = await setUp();
    (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'huge.png', size: 2_000_001 } }).assertStatus(422)).assertInvalid({
      avatar: 'The file may be at most 2 MB.',
    });
    expect(await uploadRows()).toEqual([]);
  });

  it('a session with 20 open uploads gets a 429 with the message and Retry-After for the 21st — a sent form frees a place', async () => {
    const { ada, as } = await setUp();
    app.freeze();
    const target = () => as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'a.png', size: 20 } });
    const tokens: string[] = [];
    for (let index = 0; index < 20; index++) {
      tokens.push(((await target().assertOk()).json() as { token: string }).token);
      app.travel({ seconds: 1 });
    }
    const refused = await target().assertStatus(429);
    refused.assertHeader('retry-after', String(120 * 60 - 20));
    expect(refused.json()).toMatchObject({ message: expect.stringContaining('Too many files') });
    expect(await uploadRows()).toHaveLength(20);

    await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id }).then(
      () => expect.unreachable(),
      (error: Error) => expect(error.message).toContain('429'),
    );
    app.travel({ minutes: 121 }); // all of them expired
    await target().assertOk();
  });

  it('an upload target only for a route field with an upload() rule (404), for whoever may send the form (403/401)', async () => {
    const { ada, as } = await setUp();
    const bob = await app.factory(UserFactory).create();
    const target = (who: TestApp, path: string, field: string) => who.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: field, accept: 'application/json' }).put(path, { json: { name: 'a.png', size: 10 } });
    await target(as, `/users/${ada.public_id}`, 'avatar').assertNotFound(); // the profile's route: no upload() field
    await target(as, `/users/${ada.public_id}`, 'bio').assertNotFound();
    await target(as, `/users/${ada.public_id}/avatar`, 'bio').assertNotFound(); // the avatar route, but no such field
    await target(as, `/users/${ada.public_id}/avatar`, '../avatar').assertNotFound();
    await target(app.actingAs(bob), `/users/${ada.public_id}/avatar`, 'avatar').assertForbidden(); // the route's own policy
    await target(app, `/users/${ada.public_id}/avatar`, 'avatar').assertUnauthorized();
    expect(await uploadRows()).toEqual([]);
  });

  it('what is not a verified upload never passes: a file in the body, a made-up token, a token never sent, an expired one', async () => {
    const { ada, as } = await setUp();
    await as.expectingJson().put(`/users/${ada.public_id}/avatar`, { multipart: { avatar: png() } }).assertStatus(422);
    const made = `tu_${crypto.randomUUID()}.${'A'.repeat(43)}`;
    (await send(as, ada, made).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' });
    (await send(as, ada, null).assertStatus(422)).assertInvalid({ avatar: 'Choose a file.' });

    const target = (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'a.png', size: 20 } }).assertOk()).json() as { token: string };
    (await send(as, ada, target.token).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' }); // no bytes sent

    // A real upload's id with a signature of one's own: the HMAC refuses it before anything else is looked at.
    const real = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    const forged = `${real.slice(0, 40)}${real[40] === 'A' ? 'B' : 'A'}${real.slice(41)}`;
    (await send(as, ada, forged).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' });

    const token = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    app.travel({ minutes: 121 });
    (await send(as, ada, token).assertStatus(422)).assertInvalid({ avatar: 'The upload expired — choose the file again.' });
  });

  it('a failed submit never echoes the token back (old input) — and a log of the input shows no upload', async () => {
    const { ada, as } = await setUp();
    const token = await as.upload(ROUTE, 'avatar', new File([HTML], 'x.png', { type: 'image/png' }), { user: ada.public_id });
    const response = await as.put(`/users/${ada.public_id}/avatar`, { json: { avatar: token }, headers: { accept: 'text/html', referer: `http://localhost/users/${ada.public_id}/edit` } }).assertRedirect();
    const session = JSON.stringify(response.session());
    expect(session).toContain('errors'); // the failed submit went back with its errors …
    expect(session).not.toContain(token); // … but never with the token
    expect(session).not.toContain(token.slice(3, 39));
  });

  it('an upload never writes the session: the errors of a failed submit, flashed for the next page, survive a target and the bytes', async () => {
    const { ada } = await setUp();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect();
    const browser = app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
    const edit = `http://localhost/users/${ada.public_id}/edit`;
    // A failed submit without JavaScript: back to the form, the errors flashed for exactly the next request that renders it.
    await browser.put(`/users/${ada.public_id}`, { form: { name: 'A', bio: '' }, headers: { referer: edit, accept: 'text/html' } }).assertRedirect(`/users/${ada.public_id}/edit`);
    // Meanwhile (another tab, a slow upload) a file goes ahead: neither request may age the flashed errors away.
    expect(await browser.upload(ROUTE, 'avatar', png(), { user: ada.public_id })).toMatch(/^tu_/);
    const page = (await browser.navigating().get(`/users/${ada.public_id}/edit`).assertOk()).page()!;
    expect(JSON.stringify((page.props as { errors: Record<string, unknown> }).errors.name)).toMatch(/at least/);
  });

  it('uploads:prune deletes uploads older than a day — the rows, then their files; younger ones stay and still work', async () => {
    const { ada, as } = await setUp();
    app.freeze();
    const old = await as.upload(ROUTE, 'avatar', png('old.png'), { user: ada.public_id });
    app.travel({ hours: 23 });
    const fresh = await as.upload(ROUTE, 'avatar', png('fresh.png'), { user: ada.public_id });
    app.storage.disk('uploads').assertCount(2);
    app.travel({ hours: 1, seconds: 1 });

    expect((await app.command('uploads:prune')).code).toBe(0);
    const rows = await uploadRows();
    expect(rows.map((row) => row.id)).toEqual([fresh.slice(3, 39)]);
    app.storage.disk('uploads').assertCount(1);
    (await send(as, ada, old).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' });
    await send(as, ada, fresh).assertRedirect(); // an hour old: kept by the prune, and it still works
  });

  it('uploads:prune --hours below UPLOADS_LIFETIME_MINUTES refuses without --force — a token that still works keeps its file', async () => {
    const { ada, as } = await setUp();
    app.freeze();
    const token = await as.upload(ROUTE, 'avatar', png('open-form.png'), { user: ada.public_id });
    app.travel({ minutes: 30 }); // the form is still open: the token works for 120 minutes (UPLOADS_LIFETIME_MINUTES)
    const run = (options: Record<string, string | boolean>) => app.command('uploads:prune', { options });
    const refused = await run({ hours: '0' });
    expect(refused.code).toBe(1);
    expect(refused.lines[0], refused.lines[0]).toBe(
      '✗ --hours=0 would delete uploads whose token still works: a token works for 120 minutes (UPLOADS_LIFETIME_MINUTES), so --hours must be at least 2 — or pass --force to delete them anyway (a form still open loses its files).',
    );
    expect((await run({ hours: '1.5' })).code).toBe(1);
    expect((await run({ hours: 'soon' })).code).toBe(2); // not a number: a wrong call, not the state of the uploads
    expect((await uploadRows()).map((row) => row.id)).toEqual([token.slice(3, 39)]);
    app.storage.disk('uploads').assertCount(1);
    await send(as, ada, token).assertRedirect(); // still works
    // At the lifetime it is allowed — and --force takes the user's word.
    const second = await as.upload(ROUTE, 'avatar', png('second.png'), { user: ada.public_id });
    expect((await run({ hours: '2' })).code).toBe(0);
    expect((await run({ hours: '0', force: true })).code).toBe(0);
    expect(await uploadRows()).toEqual([]);
    (await send(as, ada, second).assertStatus(422)).assertInvalid({ avatar: 'The file did not arrive — choose it again.' });
  });

  it('the system schedule runs uploads:prune hourly, the user-profile schedule clears old data exports', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    expect(app.schedule.due('2026-10-03T12:00:00Z')).toEqual(expect.arrayContaining(['uploads:prune', 'user-profile.prune-data-exports']));
  });
});

// nginx lets the bytes of an upload past its own body limit (deploy/nginx.conf): the app alone decides, with the body limit of its own
// kernel (SERVER_MAX_BODY_MB, here 1 MB) not in the way, and with every check made before the first byte is read.
describe('the bytes of an upload, where the proxy lets them through without a limit', () => {
  const MIB = 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024);
  chunk.set(PNG);

  /** A body of `length` bytes that counts the bytes pulled from it. */
  function counted(length: number) {
    const body = { pulled: 0, stream: undefined as unknown as ReadableStream<Uint8Array> };
    body.stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (body.pulled >= length) return controller.close();
        const part = chunk.subarray(0, Math.min(chunk.byteLength, length - body.pulled));
        body.pulled += part.byteLength;
        controller.enqueue(part);
      },
    });
    return body;
  }

  async function targetFor(size: number) {
    app = await createTestApp(application, { database: 'refresh', env: { SERVER_MAX_BODY_MB: '1' } });
    const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
    const as = app.actingAs(ada);
    const target = (await as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'avatar' }).put(`/users/${ada.public_id}/avatar`, { json: { name: 'big.png', size } }).assertOk()).json() as { token: string; upload: { url: string } };
    return { as: as.withHeaders({ [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream' }), target };
  }

  it('a file over the kernel’s own body limit (1 MB) is received at the size it announced', async () => {
    const size = Math.floor(1.5 * MIB);
    const { as, target } = await targetFor(size);
    const body = counted(size);
    const answer = await as.put(target.upload.url, { body: body.stream }).assertOk();
    expect(answer.json()).toEqual({ size });
    expect(body.pulled).toBe(size);
    app.storage.disk('uploads').assertCount(1);
  });

  it('a signature that does not match is a 403 before the first chunk is read — nothing is stored, the upload stays unsent', async () => {
    const { as, target } = await targetFor(Math.floor(1.5 * MIB));
    const url = new URL(target.upload.url, 'http://localhost');
    const signature = url.searchParams.get('signature')!;
    url.searchParams.set('signature', `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`);
    const body = counted(2 * MIB);
    await as.put(`${url.pathname}${url.search}`, { body: body.stream }).assertForbidden();
    expect(body.pulled).toBeLessThanOrEqual(chunk.byteLength);
    app.storage.disk('uploads').assertCount(0);
    expect((await uploadRows()).every((row) => (row as { started_at?: unknown }).started_at == null)).toBe(true);
  });

  it('a body over the announced size is cut off with a 413 — no temporary file, nothing on the disk', async () => {
    const { as, target } = await targetFor(MIB);
    const body = counted(5 * MIB);
    await as.put(target.upload.url, { body: body.stream }).assertStatus(413);
    expect(body.pulled).toBeLessThan(2 * MIB);
    app.storage.disk('uploads').assertCount(0);
  });
});

// The table of uploads is infrastructure: it never joins the app's transaction. In a test app's refreshed database (one isolated
// connection) a submit inside a transaction of the app fails loudly — never a silent join. A file of its own:
// packages/storage/src/uploads-sqlite.test.ts.
describe('a submit inside a transaction of the app', () => {
  it('in a test app (one isolated connection): a loud error, and the token is not used up', async () => {
    app = await createTestApp(application, { database: 'refresh', debug: true });
    const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
    const as = app.actingAs(ada);
    const token = await as.upload(ROUTE, 'avatar', png(), { user: ada.public_id });
    await app.make(Connections).transaction(async () => {
      const response = await send(as, ada, token).assertStatus(500);
      expect(response.body).toContain('InfrastructureTransactionError');
    });
    expect((await uploadRows()).every((row) => row.consumed_at === null)).toBe(true);
  });
});
