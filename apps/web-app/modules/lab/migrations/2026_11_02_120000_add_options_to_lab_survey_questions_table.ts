import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.alter('lab_survey_questions', (table) => {
      // The words a choice offers, as a JSON list; its type is declared in `database.ts`, and a free text has none.
      table.json('options').nullable();
    }),
  down: (schema) => schema.alter('lab_survey_questions', (table) => table.dropColumn('options')),
});
