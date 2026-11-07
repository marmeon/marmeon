/**
 * The code on the landing page — server only: `SiteSnippets` highlights it once at boot, the browser gets markup. Every snippet
 * is a piece of a file of the notes example the docs build up (`docs/migrations.md`, `docs/queries.md`, `docs/controllers.md`, …)
 * or of the example app `apps/web-app`; when the API changes, these change with it. A snippet shows no comment lines: the file it
 * comes from may have them.
 */
export type SnippetSource =
  /** A file of the smoke app (starter kit, `examples/notes`, `examples/recipes`, `examples/landing`); a `*` in the last segment stands for one file name, as in an overlay's `edits.json`. */
  | { readonly app: string }
  /** A file of this repository, for example `apps/web-app/…`. */
  | { readonly repo: string };

export interface Snippet {
  /** The name of the file the code is from, shown above it; none for a line shown on its own. */
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
  // The batteries section: one excerpt of 4 to 10 lines per package, a complete unit (balanced brackets) and a word-for-word piece of the file it names.
  batteryAuth: {
    file: 'modules/user-profile/policies/ProfileLinkPolicy.ts',
    source: { repo: 'apps/web-app/modules/user-profile/policies/ProfileLinkPolicy.ts' },
    lang: 'ts',
    code: `type OwnedLink = Pick<Row<'profile_links'>, 'user_id'>;

export class ProfileLinkPolicy {
  delete(user: AuthUser, link: OwnedLink) {
    return link.user_id === user.id || deny('user-profile.validation.own_profile');
  }
}
`,
  },
  batteryDatabase: {
    file: 'modules/auth/controllers/RegisterController.ts',
    source: { repo: 'apps/web-app/modules/auth/controllers/RegisterController.ts' },
    lang: 'ts',
    code: `    const created = await this.#connections.transaction(async () => {
      const created = await this.#users.register({ name, email, password: hash, locale });
      if (created.ok) await this.#events.dispatch(new Registered(created.value));
      return created;
    });
    if (!created.ok) throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { name, email });
`,
  },
  batteryMigrations: {
    file: 'modules/auth/migrations/2026_10_01_180000_add_locale_to_users_table.ts',
    source: { repo: 'apps/web-app/modules/auth/migrations/2026_10_01_180000_add_locale_to_users_table.ts' },
    lang: 'ts',
    code: `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.string('locale', 35).nullable()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('locale')),
});
`,
  },
  batteryValidation: {
    file: 'modules/notes/noteFields.ts',
    source: { app: 'modules/notes/noteFields.ts' },
    lang: 'ts',
    code: `import { rules as r } from '@marmeon/validation';

export const noteFields = r.object({
  title: r.string().trim().required().max(120),
  body: r.string().max(10_000),
});
`,
  },
  batteryQueue: {
    file: 'modules/account-export/jobs/SendAccountExportJob.ts',
    source: { app: 'modules/account-export/jobs/SendAccountExportJob.ts' },
    lang: 'ts',
    code: `  async handle(payload: JobPayload<typeof SendAccountExportJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user || user.email_verified_at == null) return job.discard('the account is gone or its address is not confirmed');
    await job.once(\`account-export:\${job.id}\`, () => this.#mailer.send(new AccountExportMail(user)));
  }
`,
  },
  batteryMail: {
    file: 'modules/notes/mail/NoteSharedView.tsx',
    source: { app: 'modules/notes/mail/NoteSharedView.tsx' },
    lang: 'tsx',
    code: `export function NoteSharedView({ t, title }: { t: Translator; title: string }) {
  return (
    <Layout t={t} preview={t.get('notes.mail.shared.subject')}>
      <MjmlText>{t.get('notes.mail.shared.intro', { title })}</MjmlText>
    </Layout>
  );
}
`,
  },
  batteryScheduler: {
    file: 'modules/user-profile/schedule.ts',
    source: { repo: 'apps/web-app/modules/user-profile/schedule.ts' },
    lang: 'ts',
    code: `export const schedule = defineSchedule((s) => {
  s.job(RebuildMemberStatsJob).hourly();
  s.call(PruneDataExports).everyTenMinutes().withoutOverlapping().onOneServer().name('user-profile.prune-data-exports');
});
`,
  },
  batteryStorage: {
    file: 'modules/user-profile/controllers/ExportMyDataController.ts',
    source: { repo: 'apps/web-app/modules/user-profile/controllers/ExportMyDataController.ts' },
    lang: 'ts',
    code: `    const disk = this.#storage.disk('local');
    const key = dataExportKey(user.id);
    await disk.put(key, JSON.stringify(data, null, 2), { contentType: 'application/json' });
    return this.redirect(await disk.temporaryUrl(key, { expiresIn: { minutes: 5 }, filename: \`my-data-\${user.id}.json\` })).status(303);
`,
  },
  batteryModules: {
    file: 'modules/notes/index.ts',
    source: { app: 'modules/notes/index.ts' },
    lang: 'ts',
    code: `import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
`,
  },
  islandController: {
    file: 'modules/site/controllers/ShowRenderClockController.ts',
    source: { repo: 'apps/website/modules/site/controllers/ShowRenderClockController.ts' },
    lang: 'ts',
    code: `export class ShowRenderClockController extends Controller {
  handle() {
    return this.island('site/islands/RenderClock', { renderedAt: new Date() });
  }
}
`,
  },
  islandPage: {
    file: 'modules/site/components/landing/IslandSection.tsx',
    source: { repo: 'apps/website/modules/site/components/landing/IslandSection.tsx' },
    lang: 'tsx',
    code: `const clock = (
  <Island
    route="site.render-clock"
    load="visible"
    pollMs={10_000}
    fallback={<p className="island-fallback">With JavaScript, the browser loads an island here: a part of the page the server renders on its own.</p>}
    className="island-frame"
  />
);
`,
  },
} as const satisfies Record<string, Snippet>;

export type SnippetName = keyof typeof SNIPPETS;
