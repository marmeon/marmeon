/**
 * The code on the landing page — server only: `SiteSnippets` highlights it once at boot, the browser gets markup. Every snippet
 * is a file of the notes example the docs build up (`docs/migrations.md`, `docs/queries.md`, `docs/controllers.md`, …); when
 * the API changes, these change with it. A snippet shows no comment lines: the file it comes from may have them.
 */
export type SnippetSource =
  /** A file of the smoke app (starter kit, `examples/notes`, `examples/recipes`, `examples/landing`); a `*` in the last segment stands for one file name, as in an overlay's `edits.json`. */
  | { readonly app: string }
  /** A file of this repository, for example `apps/web-app/…`. */
  | { readonly repo: string };

export interface Snippet {
  /** The file name shown above the code; none for an excerpt. */
  readonly file?: string;
  /** The type-checked file the code is a word-for-word piece of; `scripts/landing.ts` compares them. */
  readonly source: SnippetSource;
  readonly lang: 'ts' | 'tsx';
  readonly code: string;
}

export const SNIPPETS = {
  controller: {
    file: 'modules/notes/controllers/ShowNoteController.ts',
    source: { app: 'modules/notes/controllers/ShowNoteController.ts' },
    lang: 'ts',
    code: `import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const ShowNoteRequest = defineRequest({ authorize: can(NotePolicy, 'view', 'note') });

export class ShowNoteController extends Controller {
  static request = ShowNoteRequest;

  handle(ctx: ContextOf<typeof ShowNoteRequest>) {
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
`,
  },
  page: {
    file: 'modules/notes/views/Show.tsx',
    source: { app: 'modules/notes/views/Show.tsx' },
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
  // The columns of the migration, as a piece of it.
  migrationColumns: {
    file: 'modules/notes/migrations/2026_10_01_120000_create_notes_table.ts',
    source: { app: 'modules/notes/migrations/*_create_notes_table.ts' },
    lang: 'ts',
    code: `      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('title', 120);
      table.text('body');
      table.boolean('pinned').default(false);
      table.timestamps();
      table.index('user_id');
`,
  },
  tableType: {
    file: 'modules/notes/types.ts',
    source: { app: 'modules/notes/types.ts' },
    lang: 'ts',
    code: `import type { NewRow, Row, RowUpdate } from '@marmeon/database';

export type Note = Row<'notes'>;
export type NewNote = NewRow<'notes'>;
export type NoteChanges = RowUpdate<'notes'>;
`,
  },
  // The query of the repository's method, as a piece of it.
  repositoryQuery: {
    file: 'modules/notes/NoteRepository.ts',
    source: { app: 'modules/notes/NoteRepository.ts' },
    lang: 'ts',
    code: `    const query = this.query()
      .select(['id', 'title', 'body', 'pinned'])
      .where('user_id', '=', userId)
      .orderBy('pinned', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
`,
  },
  form: {
    source: { app: 'modules/notes/views/Form.tsx' },
    lang: 'tsx',
    code: `{form.error('title') && <small role="alert">{form.error('title')}</small>}
`,
  },
  test: {
    file: 'modules/notes/show.test.ts',
    source: { app: 'modules/notes/show.test.ts' },
    lang: 'ts',
    code: `it('shows a note to its author', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Groceries', body: 'Milk' });
  await app
    .actingAs(ada)
    .navigating()
    .get(\`/notes/\${note.id}\`)
    .assertOk()
    .assertPage<ShowNoteController>('notes/Show', { note: { title: 'Groceries' } });
});
`,
  },
  // A piece of a file above, where a step of the chain points at it.
  controllerCall: { source: { app: 'modules/notes/controllers/ShowNoteController.ts' }, lang: 'ts', code: `return this.view('notes/Show', { note: ctx.params.note });\n` },
  pageBody: {
    file: 'modules/notes/views/Show.tsx',
    source: { app: 'modules/notes/views/Show.tsx' },
    lang: 'tsx',
    code: `      <Head title={note.title} />
      <h1>{note.title}</h1>
      <Link route="notes.index">All notes</Link>
`,
  },
  routeLink: { source: { app: 'modules/notes/views/Show.tsx' }, lang: 'tsx', code: `<Link route="notes.index">All notes</Link>\n` },
} as const satisfies Record<string, Snippet>;

export type SnippetName = keyof typeof SNIPPETS;
