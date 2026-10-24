import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { RaceValidationLabController, StoreValidationLabController } from './controllers/ValidationLabController.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/**
 * The rules of @marmeon/validation in the app: `/lab/validation` — a request schema of `rules`, the framework's
 * messages in the request's language, the fields' names from `attributes`, a database rule that never runs live.
 */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
});
const json = { accept: 'application/json' };
afterEach(async () => {
  await app.close();
});

const valid = { name: ' Ada Lovelace ', email: ' ADA@example.com ', website: '', age: '36', terms: 'on' };

describe('the validation lab', () => {
  it('a valid form goes through — trimmed, lower-cased, empty website null, nothing saved', async () => {
    const sent = await app.post('/lab/validation', { form: valid, headers: { referer: 'http://localhost/lab/validation' } }).assertValid().assertRedirect('/lab/validation');
    await app
      .withCookie('marmeon_session', sent.cookie('marmeon_session')!)
      .navigating()
      .get('/lab/validation')
      .assertOk()
      .assertFlash('toast', { message: 'Valid: Ada Lovelace <ada@example.com> — nothing was saved.' });
    await app.assertDatabaseMissing('users', { email: 'ada@example.com' });
  });

  it('the framework\'s messages, in English — with the field names of `attributes`', async () => {
    const response = await app.post('/lab/validation', { json: { name: '', email: 'nope', website: 'javascript:alert(1)', age: '200' }, headers: json }).assertUnprocessable();
    response.assertInvalid<StoreValidationLabController>({
      name: 'The Name field is required.',
      email: 'The E-mail field must be a valid email address.',
      website: 'The website field must be a valid URL.',
      age: 'The age field must be between 1 and 150.',
      terms: 'The terms field must be accepted.',
    });
  });

  it('… and in German (Accept-Language: de)', async () => {
    const response = await app.withHeaders({ 'accept-language': 'de', ...json }).post('/lab/validation', { json: { name: 'x'.repeat(41), email: '' } }).assertUnprocessable();
    response.assertInvalid<StoreValidationLabController>({
      name: 'Das Feld Name darf höchstens 40 Zeichen haben.',
      email: 'Das Feld E-Mail ist erforderlich.',
      website: 'Das Feld website ist erforderlich.',
      terms: 'Das Feld terms muss akzeptiert werden.',
    });
  });

  it('a taken address: told on submit — never by a live validation, where a free and a taken one get the same answer', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.withHeaders({ 'accept-language': 'de', ...json }).post('/lab/validation', { json: valid }).assertUnprocessable().assertInvalid<StoreValidationLabController>({ email: 'Der Wert für E-Mail ist bereits vergeben.' });
    const taken = await app.validating('email').post('/lab/validation', { json: { email: 'ada@example.com' } }).assertLiveValid('email');
    const free = await app.validating('email').post('/lab/validation', { json: { email: 'grace@example.com' } }).assertLiveValid('email');
    expect([taken.status, taken.body]).toEqual([free.status, free.body]);
    // The address's form is checked live.
    await app.validating('email').post('/lab/validation', { json: { email: 'nope' } }).assertInvalid<StoreValidationLabController>({ email: 'The E-mail field must be a valid email address.' });
  });

  it('when: a company needs its VAT number — a person does not; r.date() and r.port() take what a form sends', async () => {
    const company = await app.post('/lab/validation', { json: { ...valid, kind: 'company', starts: '2026-02-30', port: '70000' }, headers: json }).assertUnprocessable();
    company.assertInvalid<StoreValidationLabController>({ vat: 'The vat field is required.', starts: 'The starts field must be a valid date.', port: 'The port field must be a port number from 1 to 65535.' });
    await app.post('/lab/validation', { json: { ...valid, kind: 'company', vat: 'DE123456789', starts: '2026-10-08', port: '3960' }, headers: json }).assertValid();
    await app.post('/lab/validation', { json: { ...valid, vat: 'not looked at' }, headers: json }).assertValid();
  });

  it('an async custom (an invitation code) and exists (the inviting account): on submit — never live', async () => {
    await app.factory(UserFactory).create({ email: 'grace@example.com' });
    const wrong = await app.post('/lab/validation', { json: { ...valid, invite: 'NOPE', inviter: 'nobody@example.com' }, headers: json }).assertUnprocessable();
    wrong.assertInvalid<StoreValidationLabController>({ invite: 'This invitation code is unknown.', inviter: 'The selected inviter is invalid.' });
    await app.post('/lab/validation', { json: { ...valid, invite: 'MARMEON-2026', inviter: 'grace@example.com' }, headers: json }).assertValid();
    // The form's empty fields: the code arrives as '' (a string) and its check lets it pass; the inviter (an address) is missing.
    await app.post('/lab/validation', { json: { ...valid, invite: '', inviter: '' }, headers: json }).assertValid();
    // Live: an unknown code and an unknown inviter get the answer of a known one.
    const live = async (body: Record<string, string>, field: string) => {
      const response = await app.validating(field).post('/lab/validation', { json: body }).assertLiveValid(field);
      return [response.status, response.body];
    };
    expect(await live({ invite: 'NOPE' }, 'invite')).toEqual(await live({ invite: 'MARMEON-2026' }, 'invite'));
    expect(await live({ inviter: 'nobody@example.com' }, 'inviter')).toEqual(await live({ inviter: 'grace@example.com' }, 'inviter'));
  });

  it('as after a race — no unique rule: the unique index answers through failOnDuplicate, with the same message and attributes', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const race = await app.withHeaders({ 'accept-language': 'de', ...json }).post('/lab/validation/race', { json: valid }).assertUnprocessable();
    race.assertInvalid<RaceValidationLabController>({ email: 'Der Wert für E-Mail ist bereits vergeben.' });
    // A free address: the insert met no conflict and was rolled back — nothing saved.
    await app.post('/lab/validation/race', { json: { ...valid, email: 'grace@example.com' }, headers: json }).assertValid();
    await app.assertDatabaseMissing('users', { email: 'grace@example.com' });
  });

  it('off (production): a 404 before the schema runs — no answer about any address', async () => {
    await app.close();
    const off = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'false' } });
    try {
      await off.post('/lab/validation', { json: { email: 'ada@example.com' }, headers: json }).assertNotFound();
      await off.get('/lab/validation').assertNotFound();
      await off.post('/lab/validation/race', { json: { email: 'ada@example.com' }, headers: json }).assertNotFound();
    } finally {
      await off.close();
      app = await createTestApp(application, { env: { LAB_PAGES: 'true' } }); // for afterEach
    }
  });
});
