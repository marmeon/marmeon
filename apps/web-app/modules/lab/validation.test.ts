import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { StoreValidationLabController } from './controllers/ValidationLabController.ts';

/**
 * The rules of @marmeon/validation in the app (W10 step 3, E197): `/lab/validation` — a request schema of `rules`, the framework's
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

  it('a taken address: told on submit — never by a live validation, where a free and a taken one get the same answer (E197)', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.withHeaders({ 'accept-language': 'de', ...json }).post('/lab/validation', { json: valid }).assertUnprocessable().assertInvalid<StoreValidationLabController>({ email: 'Der Wert für E-Mail ist bereits vergeben.' });
    const taken = await app.validating('email').post('/lab/validation', { json: { email: 'ada@example.com' } }).assertLiveValid('email');
    const free = await app.validating('email').post('/lab/validation', { json: { email: 'grace@example.com' } }).assertLiveValid('email');
    expect([taken.status, taken.body]).toEqual([free.status, free.body]);
    // The address's form is checked live.
    await app.validating('email').post('/lab/validation', { json: { email: 'nope' } }).assertInvalid<StoreValidationLabController>({ email: 'The E-mail field must be a valid email address.' });
  });

  it('off (production): a 404 before the schema runs — no answer about any address', async () => {
    await app.close();
    const off = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'false' } });
    try {
      await off.post('/lab/validation', { json: { email: 'ada@example.com' }, headers: json }).assertNotFound();
      await off.get('/lab/validation').assertNotFound();
    } finally {
      await off.close();
      app = await createTestApp(application, { env: { LAB_PAGES: 'true' } }); // for afterEach
    }
  });
});
