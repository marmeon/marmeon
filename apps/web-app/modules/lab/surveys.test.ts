import { Database, type Row } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { SurveyRepository } from './SurveyRepository.ts';
import { SurveyQuestionFactory } from './factories/SurveyQuestionFactory.ts';
import type { StoreSurveyLabController } from './controllers/SurveyLabController.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** `/lab/surveys/:survey`: a form whose fields are the survey's rows — its schema is built per request. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
  const inserted = await app.make(SurveyRepository).insertMany([
    { survey: 'dinner', name: 'diet', label: 'Diet', required: true, position: 1 },
    { survey: 'dinner', name: 'allergies', label: 'Allergies', required: false, position: 2 },
    { survey: 'lunch', name: 'seat', label: 'Seat', required: true, position: 1 },
  ]);
  expect(inserted).toBe(3);
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

describe('adding the questions a survey misses', () => {
  it('writes each (survey, name) once and names what it added', async () => {
    const questions = app.make(SurveyRepository);
    const added = await questions.addMissing([
      { survey: 'dinner', name: 'diet', label: 'Changed', required: false, position: 9 },
      { survey: 'dinner', name: 'drink', label: 'Drink', required: false, position: 3 },
      { survey: 'lunch', name: 'diet', label: 'Diet', required: false, position: 1 },
    ]);
    expect(added.map((question) => `${question.survey}/${question.name}`).sort()).toEqual(['dinner/drink', 'lunch/diet']);
    expect(await questions.addMissing([{ survey: 'dinner', name: 'drink', label: 'Again', required: false, position: 4 }])).toEqual([]);
    const dinner = await questions.questionsOf('dinner');
    expect(dinner.map((question) => [question.name, question.label])).toEqual([['diet', 'Diet'], ['allergies', 'Allergies'], ['drink', 'Drink']]);
  });
});

describe('the kind of a question', () => {
  it('is held to its list by the database, and its type is the union', async () => {
    const db = app.make(Database);
    const kind: Row<'lab_survey_questions'>['kind'] = 'choice';
    await db.insertInto('lab_survey_questions').values({ survey: 'dinner', name: 'drink', label: 'Drink', kind }).execute();
    const rows = await db.selectFrom('lab_survey_questions').select('kind').where('name', '=', 'drink').execute();
    expect(rows.map((row) => row.kind)).toEqual(['choice']);
    const made = await app.factory(SurveyQuestionFactory).state('choice').create();
    expect(made.kind).toBe('choice');
    // @ts-expect-error — 'essay' is not one of the kinds
    const refused = db.insertInto('lab_survey_questions').values({ survey: 'dinner', name: 'story', label: 'Story', kind: 'essay' }).execute();
    await expect(refused).rejects.toThrow(/lab_survey_questions_kind_check|CHECK constraint/i);
  });
});

describe('the options of a choice', () => {
  it('are read as the list the column declares, with no narrowing', async () => {
    expectTypeOf<Row<'lab_survey_questions'>['options']>().toEqualTypeOf<readonly string[] | null>();
    const questions = app.make(SurveyRepository);
    await questions.addMissing([{ survey: 'dinner', name: 'drink', label: 'Drink', options: ['water', 'wine'] }]);
    const drink = (await questions.questionsOf('dinner')).find((question) => question.name === 'drink')!;
    expect(drink.options?.map((option) => option.toUpperCase())).toEqual(['WATER', 'WINE']);
    expect((await questions.questionsOf('dinner')).find((question) => question.name === 'diet')!.options).toBeNull();
    const page = await app.navigating().get('/lab/surveys/dinner').assertOk().assertPage('lab/Survey');
    const shown = (page.page()!.props as { questions: { name: string; options: string[] }[] }).questions;
    expect(shown.find((question) => question.name === 'drink')!.options).toEqual(['water', 'wine']);
    expect(shown.find((question) => question.name === 'diet')!.options).toEqual([]);
  });

  it('are checked by the route’s schema before they are written, since the type checks nothing', async () => {
    const add = (options: unknown) => app.post('/lab/surveys/dinner/questions', { json: { name: 'drink', label: 'Drink', options }, headers: json });
    for (const options of [[], 'water', ['water', ''], [1, 2], Array.from({ length: 21 }, (_, i) => `w${i}`), ['x'.repeat(101)]]) {
      const response = await add(options).assertUnprocessable();
      expect(Object.keys(((await response.json()) as { errors: object }).errors).some((field) => field.startsWith('options'))).toBe(true);
    }
    expect((await app.make(SurveyRepository).questionsOf('dinner')).map((question) => question.name)).toEqual(['diet', 'allergies']);
    await add([' water ', 'wine']).assertRedirect('/lab/surveys/dinner');
    const drink = (await app.make(SurveyRepository).questionsOf('dinner')).find((question) => question.name === 'drink')!;
    expect(drink.options).toEqual(['water', 'wine']);
  });

  it('make the question a choice whose answer is one of them', async () => {
    await app.make(SurveyRepository).addMissing([{ survey: 'dinner', name: 'drink', label: 'Drink', required: true, position: 3, options: ['water', 'wine'] }]);
    const drink = (await app.make(SurveyRepository).questionsOf('dinner')).find((question) => question.name === 'drink')!;
    expect(drink.kind).toBe('choice');
    const answers = (drink: string) => ({ json: { answers: { diet: 'vegan', allergies: '', drink } }, headers: json });
    await app.post('/lab/surveys/dinner', answers('wine')).assertRedirect('/lab/surveys/dinner');
    const response = await app.post('/lab/surveys/dinner', answers('beer')).assertUnprocessable();
    expect(Object.keys(((await response.json()) as { errors: object }).errors)).toEqual(['answers.drink']);
    await app.make(SurveyRepository).addMissing([{ survey: 'lunch', name: 'side', label: 'Side', required: false, options: ['rice'] }]);
    await app.post('/lab/surveys/lunch', { json: { answers: { seat: '1', side: '' } }, headers: json }).assertRedirect('/lab/surveys/lunch');
  });

  it('come with a name that is a plain word, since the name becomes a key of the answers', async () => {
    for (const name of ['a.b', '__proto__', 'Upper', '1st', 'a b', '']) {
      const response = await app.post('/lab/surveys/dinner/questions', { json: { name, label: 'L', options: ['x'] }, headers: json }).assertUnprocessable();
      expect(Object.keys(((await response.json()) as { errors: object }).errors)).toContain('name');
    }
    expect((await app.make(SurveyRepository).questionsOf('dinner')).map((question) => question.name)).toEqual(['diet', 'allergies']);
  });

  it('are checked by the repository too, for a caller that is no request', async () => {
    const refused = app.make(SurveyRepository).addMissing([{ survey: 'dinner', name: 'drink', label: 'Drink', options: [''] }]);
    await expect(refused).rejects.toThrow('not a list of words');
  });

  it('are not checked when read: a row written by raw SQL reads as it is', async () => {
    await app.make(Database).insertInto('lab_survey_questions').values({ survey: 'dinner', name: 'odd', label: 'Odd', options: JSON.stringify({ not: 'a list' }) }).execute();
    const odd = (await app.make(SurveyRepository).questionsOf('dinner')).find((question) => question.name === 'odd')!;
    expect(odd.options).toEqual({ not: 'a list' });
  });
});
