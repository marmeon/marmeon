import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('lab_survey_questions', (table) => {
      table.uuidId();
      // The survey a question belongs to — the `:survey` of the path — and the key of its answer in the form.
      table.string('survey', 60);
      table.string('name', 60);
      table.string('label', 200);
      table.boolean('required').default(true);
      table.integer('position').default(0);
      table.unique(['survey', 'name']);
      table.timestamps();
    }),
  down: (schema) => schema.drop('lab_survey_questions'),
});
