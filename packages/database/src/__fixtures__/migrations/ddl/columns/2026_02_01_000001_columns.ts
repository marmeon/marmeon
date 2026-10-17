import { defineMigration } from '../../../../index.ts';

// Every kind of column and every modifier. What this writes is held in `__fixtures__/formats/ddl`.
export default defineMigration({
  up: async (schema) => {
    await schema.create('ddl_people', (table) => {
      table.id();
      table.string('name');
    });
    await schema.create('ddl_kinds', (table) => {
      table.id('kind_id');
      table.string('label', 40);
      table.text('body');
      table.integer('count');
      table.bigInteger('big');
      table.float('ratio');
      table.decimal('price');
      table.decimal('exact', 12, 4);
      table.boolean('flag');
      table.json('meta');
      table.uuid('token');
      table.binary('blob');
      table.date('day');
      table.timestamp('at');
    });
    await schema.create('ddl_modifiers', (table) => {
      table.uuidId();
      table.string('email').unique();
      table.string('nickname').nullable();
      table.string('role').default('member');
      table.integer('level').default(1);
      table.boolean('active').default(true);
      table.json('settings').default({});
      table.string('password').secret();
      table.string('api_key').nullable().secret().unique();
      table.uuid('public_id').useUuidv7().unique();
      table.timestamp('seen_at').useCurrent().nullable();
      table.timestamps();
      table.softDeletes();
    });
    await schema.create('ddl_categories', (table) => {
      table.id();
      table.string('title');
    });
    await schema.create('ddl_codes', (table) => {
      table.string('code').primary();
      table.string('title');
    });
    await schema.create('ddl_keys', (table) => {
      table.id();
      table.foreignId('person_id').constrained('ddl_people').cascadeOnDelete();
      table.foreignId('editor_id').constrained('ddl_people').nullOnDelete().inverse('edited_keys').nullable();
      table.foreignId('owner_id').constrained('ddl_people').restrictOnDelete();
      table.foreignId('plain_id').constrained('ddl_people');
      table.foreignUuid('modifier_id').constrained('ddl_modifiers').cascadeOnDelete().nullable();
      table.foreignId('loose_id');
      table.foreignId('ddl_category_id').constrained();
    });
  },
  down: async (schema) => {
    await schema.drop('ddl_keys');
    await schema.drop('ddl_codes');
    await schema.drop('ddl_categories');
    await schema.drop('ddl_modifiers');
    await schema.drop('ddl_kinds');
    await schema.drop('ddl_people');
  },
});
