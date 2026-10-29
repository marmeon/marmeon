import { Database } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import type { StoreSurveyLabController } from './controllers/SurveyLabController.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** `/lab/surveys/:survey`: a form whose fields are the survey's rows — its schema is built per request. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
  await app
    .make(Database)
    .insertInto('lab_survey_questions')
    .values([
      { survey: 'dinner', name: 'diet', label: 'Diet', required: true, position: 1 },
      { survey: 'dinner', name: 'allergies', label: 'Allergies', required: false, position: 2 },
      { survey: 'lunch', name: 'seat', label: 'Seat', required: true, position: 1 },
    ])
    .execute();
});
afterEach(async () => {
  await app.close();
});

const json = { accept: 'application/json' };

describe('a form built from rows', () => {
  it('shows the questions of the survey in the path', async () => {
    const page = await app.navigating().get('/lab/surveys/dinner').assertOk().assertPage('lab/Survey');
    const { questions } = page.page()!.props as { questions: { name: string }[] };
    expect(questions.map((question) => question.name)).toEqual(['diet', 'allergies']);
  });

  it('validates the answers against the rows of that survey, required or not', async () => {
    await app.post('/lab/surveys/dinner', { json: { answers: { diet: 'vegan', allergies: '' } }, headers: json }).assertRedirect('/lab/surveys/dinner');
    const response = await app.post('/lab/surveys/dinner', { json: { answers: { diet: ' ', allergies: 'x'.repeat(501) } }, headers: json }).assertUnprocessable();
    response.assertInvalid<StoreSurveyLabController>({
      'answers.diet': 'The answers.diet field is required.',
      'answers.allergies': 'The answers.allergies field must not be longer than 500 characters.',
    });
  });

  it('takes another survey\'s question for no field of this one', async () => {
    const response = await app.post('/lab/surveys/dinner', { json: { answers: { seat: '12A' } }, headers: json }).assertUnprocessable();
    response.assertInvalid<StoreSurveyLabController>({ 'answers.diet': 'The answers.diet field is required.' });
    await app.post('/lab/surveys/lunch', { json: { answers: { seat: '12A' } }, headers: json }).assertRedirect('/lab/surveys/lunch');
  });

  it('answers 404 for a survey without questions', async () => {
    await app.get('/lab/surveys/breakfast').assertNotFound();
    await app.post('/lab/surveys/breakfast', { json: { answers: {} }, headers: json }).assertNotFound();
  });

  it('answers 404 unless the lab is on', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'false' } });
    await app.make(Database).insertInto('lab_survey_questions').values({ survey: 'dinner', name: 'diet', label: 'Diet' }).execute();
    await app.post('/lab/surveys/dinner', { json: { answers: {} }, headers: json }).assertNotFound();
  });
});
