/**
 * The code on the landing page — server only: `SiteSnippets` highlights it once at boot, the browser gets markup. Every snippet
 * is a file of the notes example the docs build up (`docs/migrations.md`, `docs/queries.md`, `docs/controllers.md`, …); when
 * the API changes, these change with it.
 */
export interface Snippet {
  /** The file name shown above the code; none for an excerpt. */
  readonly file?: string;
  readonly lang: 'ts' | 'tsx';
  readonly code: string;
}

export const SNIPPETS = {
  routes: {
    file: 'modules/notes/routes.ts',
    lang: 'ts',
    code: `import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).name('notes.');

  // The list asks for the signed-in user's notes; the note route is decided by its request (NotePolicy).
  notes.authorize(everyone).get('/', ListNotesController).name('index');
  notes.bind('note', NoteRepository).get('/:note', ShowNoteController).name('show');
});
`,
  },
  controller: {
    file: 'modules/notes/controllers/ShowNoteController.ts',
    lang: 'ts',
    code: `import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const ShowNoteRequest = defineRequest({ authorize: can(NotePolicy, 'view', 'note') });

export class ShowNoteController extends Controller {
  static request = ShowNoteRequest;

  // \`note\` is bound by the route: a missing one is a 404.
  handle(ctx: ContextOf<typeof ShowNoteRequest>) {
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
`,
  },
  page: {
    file: 'modules/notes/views/Show.tsx',
    lang: 'tsx',
    code: `import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';

export default function Show({ note }: PageProps<ShowNoteController>) {
  return (
    <main>
      <Head title={note.title} />
      <h1>{note.title}</h1>
      <Link route="notes.index">All notes</Link>
    </main>
  );
}
`,
  },
  migration: {
    file: 'modules/notes/migrations/2026_10_01_120000_create_notes_table.ts',
    lang: 'ts',
    code: `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 200);
      table.text('body');
      table.timestamps();
    }),
  down: (schema) => schema.drop('notes'),
});
`,
  },
  tableType: {
    file: 'modules/notes/types.ts',
    lang: 'ts',
    code: `import type { NewRow, Row, RowUpdate } from '@marmeon/database';

export type Note = Row<'notes'>; // a row as read
export type NewNote = NewRow<'notes'>; // what an insert takes
export type NoteChanges = RowUpdate<'notes'>; // what an update takes
`,
  },
  repository: {
    file: 'modules/notes/NoteRepository.ts',
    lang: 'ts',
    code: `import { Repository } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;

  latestOf(userId: number) {
    return this.query().selectAll().where('user_id', '=', userId).orderBy('updated_at', 'desc').limit(10).execute();
  }
}
`,
  },
  form: {
    lang: 'tsx',
    code: `const form = useForm('notes.update', { title: note.title, body: note.body }, { params: { note: note.id } });
form.errors.title
`,
  },
  test: {
    file: 'modules/notes/show.test.ts',
    lang: 'ts',
    code: `it('shows a note to its author', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });
  await app
    .actingAs(ada)
    .navigating()
    .get(\`/notes/\${note.id}\`)
    .assertOk()
    .assertPage<ShowNoteController>('notes/Show', { note: { title: 'Groceries' } });
});
`,
  },
  // One line of a file above, where a step of the chain points at it.
  controllerCall: { lang: 'ts', code: `return this.view('notes/Show', { note: ctx.params.note });\n` },
  pageSignature: { lang: 'tsx', code: `export default function Show({ note }: PageProps<ShowNoteController>)\n` },
  routeLink: { lang: 'tsx', code: `<Link route="notes.index">All notes</Link>\n` },
} as const satisfies Record<string, Snippet>;

export type SnippetName = keyof typeof SNIPPETS;
