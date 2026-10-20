import { POLICY, TEST_SETUP } from './make.ts';

/** Every name of a resource, derived once from `<Name>` (and `--module`) before any file is written. */
export interface ResourceNames {
  /** `BlogPost` */
  readonly name: string;
  /** `BlogPosts` */
  readonly plural: string;
  /** `blog-posts`: the folder of the module and the prefix of its URLs and route names. */
  readonly module: string;
  /** `blog_posts` */
  readonly table: string;
  /** `blogPost`: the route parameter and the key of a record in a page's props. */
  readonly param: string;
  /** `blogPosts`: the key of the list in a page's props. */
  readonly list: string;
  /** `blog post` */
  readonly words: string;
  /** `blog posts` */
  readonly pluralWords: string;
  /** How a view in `views/` imports the app layout. */
  readonly layout: string;
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The path of every file of a resource, relative to `modules/<module>/`, with its contents. The migration's name takes the stamp. */
export function resourceFiles(n: ResourceNames, stamp: string): Map<string, string> {
  return new Map([
    ['index.ts', INDEX(n)],
    ['routes.ts', ROUTES(n)],
    [`migrations/${stamp}_create_${n.table}_table.ts`, MIGRATION(n)],
    [`${n.name}Repository.ts`, REPOSITORY(n)],
    [`policies/${n.name}Policy.ts`, POLICY(`${n.name}Policy`, `Row<'${n.table}'>`, "import type { Row } from '@marmeon/database';")],
    [`controllers/List${n.plural}Controller.ts`, LIST(n)],
    [`controllers/Create${n.name}Controller.ts`, CREATE(n)],
    [`controllers/Store${n.name}Controller.ts`, STORE(n)],
    [`controllers/Edit${n.name}Controller.ts`, EDIT(n)],
    [`controllers/Update${n.name}Controller.ts`, UPDATE(n)],
    [`controllers/Delete${n.name}Controller.ts`, DELETE(n)],
    [`views/List${n.plural}.tsx`, LIST_VIEW(n)],
    ['views/Form.tsx', FORM_VIEW(n)],
    [`${n.module}.test.ts`, TEST(n)],
  ]);
}

const INDEX = (n: ResourceNames) => `import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: '${n.module}',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
`;

const ROUTES = (n: ResourceNames) => `import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { Create${n.name}Controller } from './controllers/Create${n.name}Controller.ts';
import { Delete${n.name}Controller } from './controllers/Delete${n.name}Controller.ts';
import { Edit${n.name}Controller } from './controllers/Edit${n.name}Controller.ts';
import { List${n.plural}Controller } from './controllers/List${n.plural}Controller.ts';
import { Store${n.name}Controller } from './controllers/Store${n.name}Controller.ts';
import { Update${n.name}Controller } from './controllers/Update${n.name}Controller.ts';
import { ${n.name}Repository } from './${n.name}Repository.ts';

// Signed in, with a confirmed address. A ${n.words} in the URL is looked up by its id and then checked
// against the signed-in user by ${n.name}Policy: somebody else's ${n.words} is a 404.
export default defineRoutes((Route) => {
  const ${n.list} = Route.prefix('/${n.module}').middleware(authenticate()).middleware(verified()).name('${n.module}.');

  // These three never take a ${n.words} from the path: the list asks for \`ctx.user.id\`, and a new ${n.words} is created for the signed-in user.
  const mine = ${n.list}.authorize(everyone);
  mine.get('/', List${n.plural}Controller).name('index');
  mine.get('/create', Create${n.name}Controller).name('create');
  mine.post('/', Store${n.name}Controller).name('store');

  const ${n.param} = ${n.list}.bind('${n.param}', ${n.name}Repository);
  ${n.param}.get('/:${n.param}/edit', Edit${n.name}Controller).name('edit');
  ${n.param}.put('/:${n.param}', Update${n.name}Controller).name('update');
  ${n.param}.delete('/:${n.param}', Delete${n.name}Controller).name('destroy');
});
`;

const MIGRATION = (n: ResourceNames) => `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('${n.table}', (table) => {
      // A UUIDv7 as the primary key: the id is in URLs, and the next one cannot be guessed.
      table.uuidId();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('title', 120);
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('${n.table}'),
});
`;

const REPOSITORY = (n: ResourceNames) => `import { Repository, type PageRequest, type Row } from '@marmeon/database';

export class ${n.name}Repository extends Repository<'${n.table}'> {
  static table = '${n.table}' as const;

  /** One page of a user's ${n.pluralWords}, the most recently changed first. Only what the page shows. */
  pageOf(userId: Row<'${n.table}'>['user_id'], page: PageRequest) {
    const query = this.query()
      .select(['id', 'title'])
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
`;

const LIST = (n: ResourceNames) => `import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { ${n.name}Repository } from '../${n.name}Repository.ts';

export const List${n.plural}Request = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 10 }) }),
});

/** The signed-in user's ${n.pluralWords}, ten to a page. */
export class List${n.plural}Controller extends Controller {
  static request = List${n.plural}Request;

  readonly #${n.list}: ${n.name}Repository;

  constructor(${n.list}: ${n.name}Repository) {
    super();
    this.#${n.list} = ${n.list};
  }

  async handle(ctx: ContextOf<typeof List${n.plural}Request> & Authenticated) {
    return this.view('${n.module}/List${n.plural}', { ${n.list}: await this.#${n.list}.pageOf(ctx.user.id, ctx.query) });
  }
}
`;

const CREATE = (n: ResourceNames) => `import { Controller } from '@marmeon/http';

/** The empty form of a new ${n.words}. */
export class Create${n.name}Controller extends Controller {
  handle() {
    return this.view('${n.module}/Form', { ${n.param}: null });
  }
}
`;

const STORE = (n: ResourceNames) => `import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { ${n.name}Repository } from '../${n.name}Repository.ts';

// What the form sends: a title. Nothing else — the owner is the signed-in user, never a field.
export const Store${n.name}Request = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
  }),
});

/** Saves a new ${n.words} for the signed-in user. */
export class Store${n.name}Controller extends Controller {
  static request = Store${n.name}Request;

  readonly #${n.list}: ${n.name}Repository;

  constructor(${n.list}: ${n.name}Repository) {
    super();
    this.#${n.list} = ${n.list};
  }

  async handle(ctx: ContextOf<typeof Store${n.name}Request> & Authenticated) {
    await this.#${n.list}.insert({ user_id: ctx.user.id, title: ctx.body.title });
    return this.redirect().route('${n.module}.index').flash('toast', { kind: 'success', message: '${upperFirst(n.words)} saved.' });
  }
}
`;

const EDIT = (n: ResourceNames) => `import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { ${n.name}Policy } from '../policies/${n.name}Policy.ts';

export const Edit${n.name}Request = defineRequest({ authorize: can(${n.name}Policy, 'update', '${n.param}') });

/** The form of one of the user's ${n.pluralWords} — somebody else's answers 404 before this runs. */
export class Edit${n.name}Controller extends Controller {
  static request = Edit${n.name}Request;

  handle(ctx: ContextOf<typeof Edit${n.name}Request>) {
    const { id, title } = ctx.params.${n.param};
    return this.view('${n.module}/Form', { ${n.param}: { id, title } });
  }
}
`;

const UPDATE = (n: ResourceNames) => `import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { ${n.name}Repository } from '../${n.name}Repository.ts';
import { ${n.name}Policy } from '../policies/${n.name}Policy.ts';

export const Update${n.name}Request = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
  }),
  authorize: can(${n.name}Policy, 'update', '${n.param}'),
});

/** Saves the changes to one of the user's ${n.pluralWords}. */
export class Update${n.name}Controller extends Controller {
  static request = Update${n.name}Request;

  readonly #${n.list}: ${n.name}Repository;

  constructor(${n.list}: ${n.name}Repository) {
    super();
    this.#${n.list} = ${n.list};
  }

  async handle(ctx: ContextOf<typeof Update${n.name}Request>) {
    await this.#${n.list}.update(ctx.params.${n.param}.id, { title: ctx.body.title });
    return this.redirect().route('${n.module}.index').flash('toast', { kind: 'success', message: '${upperFirst(n.words)} saved.' });
  }
}
`;

const DELETE = (n: ResourceNames) => `import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { ${n.name}Repository } from '../${n.name}Repository.ts';
import { ${n.name}Policy } from '../policies/${n.name}Policy.ts';

export const Delete${n.name}Request = defineRequest({ authorize: can(${n.name}Policy, 'delete', '${n.param}') });

/** Deletes one of the user's ${n.pluralWords}. */
export class Delete${n.name}Controller extends Controller {
  static request = Delete${n.name}Request;

  readonly #${n.list}: ${n.name}Repository;

  constructor(${n.list}: ${n.name}Repository) {
    super();
    this.#${n.list} = ${n.list};
  }

  async handle(ctx: ContextOf<typeof Delete${n.name}Request>) {
    await this.#${n.list}.delete(ctx.params.${n.param}.id);
    return this.redirect().route('${n.module}.index').flash('toast', { kind: 'success', message: '${upperFirst(n.words)} deleted.' });
  }
}
`;

const LIST_VIEW = (n: ResourceNames) => `import type { PageProps } from '@marmeon/http';
import { Head, Link, Pagination } from '@marmeon/react';
import { AppLayout } from '${n.layout}';
import type { List${n.plural}Controller } from '../controllers/List${n.plural}Controller.ts';

type Props = PageProps<List${n.plural}Controller>;

export default function List${n.plural}({ ${n.list} }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="${upperFirst(n.pluralWords)}" />
      <div className="cluster">
        <h1>${upperFirst(n.pluralWords)}</h1>
        <Link route="${n.module}.create" className="button">
          New ${n.words}
        </Link>
      </div>
      {${n.list}.data.length === 0 && <p className="muted">No ${n.pluralWords} yet.</p>}
      <div className="stack">
        {${n.list}.data.map((${n.param}) => (
          <article key={${n.param}.id} className="card">
            <h2>{${n.param}.title}</h2>
            <div className="cluster">
              <Link route="${n.module}.edit" params={{ ${n.param}: ${n.param}.id }} className="button-secondary" data-size="small">
                Edit
              </Link>
              <Link
                route="${n.module}.destroy"
                params={{ ${n.param}: ${n.param}.id }}
                className="button-secondary"
                data-size="small"
                data-destructive=""
                confirm={{ title: \`Delete \${${n.param}.title}?\`, message: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }}
              >
                Delete
              </Link>
            </div>
          </article>
        ))}
      </div>
      <Pagination
        meta={${n.list}.meta}
        labels={{ navigation: 'Pages', previous: 'Previous', next: 'Next', page: (page) => \`Page \${page}\` }}
      />
    </main>
  );
}

List${n.plural}.layout = AppLayout;
`;

const FORM_VIEW = (n: ResourceNames) => `import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, type FormFieldsOf, type FormRenderState } from '@marmeon/react';
import { AppLayout } from '${n.layout}';
import type { Create${n.name}Controller } from '../controllers/Create${n.name}Controller.ts';
import type { Edit${n.name}Controller } from '../controllers/Edit${n.name}Controller.ts';

type Props = PageProps<Create${n.name}Controller> | PageProps<Edit${n.name}Controller>;

export default function ${n.name}Form({ ${n.param} }: Props) {
  const title = ${n.param} ? 'Edit ${n.words}' : 'New ${n.words}';
  // The same fields for both routes: \`${n.module}.update\` takes what \`${n.module}.store\` takes.
  const fields = (form: FormRenderState<FormFieldsOf<'${n.module}.store'>>) => (
    <>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" defaultValue={${n.param}?.title} maxLength={120} {...form.field('title')} />
        {form.error('title') && <small role="alert">{form.error('title')}</small>}
      </div>
      <div className="cluster">
        <button type="submit" className="button" disabled={form.processing}>
          Save
        </button>
        <Link route="${n.module}.index" className="button-secondary">
          Cancel
        </Link>
      </div>
    </>
  );

  return (
    <main className="app-main stack stack-loose">
      <Head title={title} />
      <h1>{title}</h1>
      <section className="card">
        {${n.param} ? (
          <Form route="${n.module}.update" params={{ ${n.param}: ${n.param}.id }} className="stack" guard="You have unsaved changes. Leave anyway?">
            {fields}
          </Form>
        ) : (
          <Form route="${n.module}.store" className="stack" guard="You have unsaved changes. Leave anyway?">
            {fields}
          </Form>
        )}
      </section>
    </main>
  );
}

${n.name}Form.layout = AppLayout;
`;

const TEST = (n: ResourceNames) => `import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory, UserRepository } from '../auth/index.ts';
import type { List${n.plural}Controller } from './controllers/List${n.plural}Controller.ts';
import { ${n.name}Repository } from './${n.name}Repository.ts';

// Who may see and change which ${n.words}.

${TEST_SETUP}
const ${n.list} = () => app.make(${n.name}Repository);

describe('the ${n.pluralWords}', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page', async () => {
    await app.get('/${n.module}').assertRedirect('/login');
    await app.get('/${n.module}/create').assertRedirect('/login');
    await app.post('/${n.module}', { form: { title: 'Hello' } }).assertRedirect('/login');
  });

  it('lists only the ${n.pluralWords} of the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await ${n.list}().insert({ user_id: ada.id, title: 'First' });
    await ${n.list}().insert({ user_id: ada.id, title: 'Second' });
    await ${n.list}().insert({ user_id: bob.id, title: 'Secret' });

    await app.actingAs(ada).navigating().get('/${n.module}').assertPage<List${n.plural}Controller>('${n.module}/List${n.plural}', (props) => {
      expect(props.${n.list}.data.map((${n.param}) => ${n.param}.title).sort()).toEqual(['First', 'Second']);
      expect(props.${n.list}.meta.total).toBe(2);
    });
  });

  it('creates a ${n.words} for the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/${n.module}/create').assertPage('${n.module}/Form', { ${n.param}: null });
    await app.actingAs(ada).post('/${n.module}', { form: { title: '  First  ' } }).assertRedirect('/${n.module}');
    expect(await ${n.list}().firstWhere({ user_id: ada.id })).toMatchObject({ title: 'First' });
  });

  it('keeps a ${n.words} for the signed-in user whatever the form says', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/${n.module}', { form: { title: 'Mine', user_id: String(bob.id) } }).assertRedirect('/${n.module}');
    expect(await ${n.list}().findBy('title', 'Mine')).toMatchObject({ user_id: ada.id });
  });

  it('refuses a ${n.words} without a title or with a title that is too long', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/${n.module}', { form: { title: ' ' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/${n.module}', { form: { title: 'x'.repeat(121) } }).assertRedirect().assertInvalid(['title']);
    expect(await ${n.list}().count()).toBe(0);
  });

  it('changes a ${n.words}', async () => {
    const ada = await app.factory(UserFactory).create();
    const ${n.param} = await ${n.list}().insert({ user_id: ada.id, title: 'Draft' });
    await app.actingAs(ada).navigating().get(\`/${n.module}/\${${n.param}.id}/edit\`).assertPage('${n.module}/Form', { ${n.param}: { id: ${n.param}.id, title: 'Draft' } });
    await app.actingAs(ada).put(\`/${n.module}/\${${n.param}.id}\`, { form: { title: 'Final' } }).assertRedirect('/${n.module}');
    expect(await ${n.list}().find(${n.param}.id)).toMatchObject({ title: 'Final' });
    await app.actingAs(ada).put(\`/${n.module}/\${${n.param}.id}\`, { form: { title: '' } }).assertRedirect().assertInvalid(['title']);
  });

  it('deletes a ${n.words}', async () => {
    const ada = await app.factory(UserFactory).create();
    const ${n.param} = await ${n.list}().insert({ user_id: ada.id, title: 'Obsolete' });
    await app.actingAs(ada).delete(\`/${n.module}/\${${n.param}.id}\`).assertRedirect('/${n.module}');
    expect(await ${n.list}().find(${n.param}.id)).toBeUndefined();
  });

  it("answers 404 for somebody else's ${n.words}, however it is reached", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const ${n.param} = await ${n.list}().insert({ user_id: bob.id, title: 'Secret' });
    const asAda = app.actingAs(ada);
    await asAda.get(\`/${n.module}/\${${n.param}.id}/edit\`).assertNotFound();
    await asAda.put(\`/${n.module}/\${${n.param}.id}\`, { form: { title: 'Mine now' } }).assertNotFound();
    await asAda.delete(\`/${n.module}/\${${n.param}.id}\`).assertNotFound();
    await asAda.get('/${n.module}/no-such-id/edit').assertNotFound();
    expect(await ${n.list}().find(${n.param}.id)).toMatchObject({ title: 'Secret' });
  });

  it('deletes the ${n.pluralWords} with their user', async () => {
    const ada = await app.factory(UserFactory).create();
    await ${n.list}().insert({ user_id: ada.id, title: 'Gone with Ada' });
    await app.make(UserRepository).deleteAccounts([ada.id]);
    expect(await ${n.list}().count()).toBe(0);
  });
});
`;
