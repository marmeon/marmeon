import { defineFactory } from '@marmeon/database';

/** A question whose `name`, the key of its answer in the form, is derived from the `label` the row ends up with. */
export const LabeledQuestionFactory = defineFactory('lab_survey_questions', ({ sequence }) => ({
  survey: 'dinner',
  label: `Favourite dish ${sequence}`,
  name: (row) => String(row.label).toLowerCase().replaceAll(/\W+/g, '-'),
}));
