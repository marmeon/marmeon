import { defineFactory } from '@marmeon/database';

/** A question of a survey: its `kind` is a `oneOf()` column, so `'text'` and `'choice'` need no `as const`. */
export const SurveyQuestionFactory = defineFactory(
  'lab_survey_questions',
  ({ sequence }) => ({ survey: 'dinner', name: `question-${sequence}`, label: `Question ${sequence}`, kind: 'text' }),
  { states: { choice: { kind: 'choice' }, pick: ({ sequence }) => ({ kind: sequence % 2 ? 'choice' : 'text' }) } },
);
