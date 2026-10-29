import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.alter('lab_survey_questions', (table) => {
      // A question is a free text or a choice; the database refuses any other word, and `Row<…>['kind']` is the union.
      table.string('kind', 20).oneOf('text', 'choice').default('text');
    }),
  down: (schema) => schema.alter('lab_survey_questions', (table) => table.dropColumn('kind')),
});
