import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import type { StoreGuestLabController, UpdateGuestLabController } from './controllers/GuestLabController.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** `/lab/guests`: a create and an edit form that share the component of their common fields (`FormPart`). */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
});
afterEach(async () => {
  await app.close();
});

const json = { accept: 'application/json' };

describe('a create and an edit form with shared fields', () => {
  it('shows both forms', async () => {
    await app.navigating().get('/lab/guests/new').assertOk().assertPage('lab/GuestCreate');
    await app.navigating().get('/lab/guests/edit').assertOk().assertPage('lab/GuestEdit');
  });

  it('the create form validates the shared fields and its own', async () => {
    await app.post('/lab/guests', { json: { name: 'Ada', email: ' ADA@example.test ' }, headers: json }).assertRedirect('/lab/guests/new');
    const response = await app.post('/lab/guests', { json: { name: '', email: 'nope', invite: 'x'.repeat(41) }, headers: json }).assertUnprocessable();
    response.assertInvalid<StoreGuestLabController>({
      name: 'The name field is required.',
      email: 'The email field must be a valid email address.',
      invite: 'The invite field must not be longer than 40 characters.',
    });
  });

  it('the edit form validates the same shared fields and its own', async () => {
    await app.put('/lab/guests', { json: { name: 'Ada', email: 'ada@example.test', coming: false }, headers: json }).assertRedirect('/lab/guests/edit');
    const response = await app.put('/lab/guests', { json: { name: '', email: 'nope', coming: 'maybe' }, headers: json }).assertUnprocessable();
    response.assertInvalid<UpdateGuestLabController>({
      name: 'The name field is required.',
      email: 'The email field must be a valid email address.',
      coming: 'The coming field must be true or false.',
    });
  });

  it('a boolean field takes what a form without JavaScript sends: a ticked box, a hidden 0 or 1', async () => {
    const referer = { referer: 'http://localhost/lab/guests/edit' };
    const send = (fields: Record<string, string>) => app.put('/lab/guests', { form: { name: 'Ada', email: 'ada@example.test', ...fields }, headers: referer });
    for (const coming of ['on', '1', '0']) {
      (await send({ coming })).assertValid().assertRedirect('/lab/guests/edit');
    }
    // An unticked box without a hidden 0 sends nothing, and a word that is no yes or no is no boolean.
    (await send({})).assertInvalid<UpdateGuestLabController>({ coming: 'The coming field is required.' });
    (await send({ coming: 'maybe' })).assertInvalid<UpdateGuestLabController>({ coming: 'The coming field must be true or false.' });
  });

  it('answers 404 unless the lab is on', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh' });
    await app.navigating().get('/lab/guests/new').assertNotFound();
  });
});
