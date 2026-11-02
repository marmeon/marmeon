import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { LabeledQuestionFactory } from './factories/LabeledQuestionFactory.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});
afterEach(async () => {
  await app.close();
});

it('derives a column from the row the factory makes', async () => {
  const question = await app.factory(LabeledQuestionFactory).create({ label: 'Main Course' });
  expect(question.name).toBe('main-course');
  const defaults = await app.factory(LabeledQuestionFactory).count(2).create();
  expect(defaults.map((row) => row.name)).toEqual(['favourite-dish-2', 'favourite-dish-3']);
});

it('leaves the derived column alone when the call or a state names it', async () => {
  expect((await app.factory(LabeledQuestionFactory).create({ name: 'chosen' })).name).toBe('chosen');
  expect((await app.factory(LabeledQuestionFactory).state({ name: 'stated' }).create({ label: 'Other' })).name).toBe('stated');
});

it('makes the derived attributes without inserting', () => {
  expect(app.factory(LabeledQuestionFactory).make({ label: 'Dessert' })).toMatchObject({ name: 'dessert', label: 'Dessert' });
});
