import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => schema.dropIfExists('app.Migration_Interruption'),
});
