# Your First App

## Introduction

This guide builds a small notes app on the starter kit, from `pnpm create marmeon` to a page where people write, pin and delete
their own notes. Along the way you meet the parts of a Marmeon app: a module, a table, a repository, routes, controllers, pages, a
policy and tests.

You write a module of about twenty files, and the guide shows every one of them in full, so you can copy each into place. The page
is long for that reason: it is one walk-through, and nothing in it is left to guess. The same files make up the notes example in
the framework's repository, and the framework's own checks build an app from them and run its tests, so the code on this page
runs.

```text
modules/notes/
├── index.ts
├── routes.ts
├── NoteRepository.ts
├── noteFields.ts
├── notes.test.ts
├── migrations/
├── controllers/
├── policies/
├── views/
└── lang/
```

You need Node.js 26.10 or newer and pnpm, as the [installation](installation.md) page lists. The commands use pnpm. With npm, run
`npx marmeon …` for the `pnpm marmeon …` commands and `npm run …` for the scripts.

## Create the app

```sh
pnpm create marmeon my-app
cd my-app
```

With npm, the creator reads `npm create marmeon@latest my-app -- --npm`. The creator copies the [starter kit](starter-kit.md),
installs it and makes a first commit. `pnpm dev` starts the app on http://localhost:3000. Register an account there and confirm
its address as the [installation](installation.md#your-first-account) page describes. The notes app needs a signed-in user,
because every note belongs to one.

## A look around

Three folders matter for this guide:

| Path | What it holds |
| --- | --- |
| `modules/` | The app's features. The starter kit brings `auth` (accounts, the app's layout), `home` (the page at `/`) and `system`. Your notes become a fourth module. |
| `bootstrap/` | The files that connect the parts. `app.ts` lists the modules. `routes.ts` and `database.d.ts` are generated: the names of the routes and the types of the tables. |
| `styles/` | `app.css`, the starter kit's tokens and the classes its pages use. |

A module is a folder with an `index.ts` that says what the module contributes: routes, migrations, providers, commands. The rest
of its files are found by their place. A route names its controller, a page is the file under `views/` that a controller names,
and a test is any `modules/**/*.test.ts`. The [modules](modules.md#defining-a-module) page lists the keys of `index.ts`, and
[directory structure](structure.md) walks through each folder.

The pages of the starter kit use a small set of classes from `styles/app.css`. The notes pages use the same classes and no styles
of their own, so they look like the rest of the app. [The look](starter-kit.md#the-look) lists the classes.

## A module for notes

A module and its controllers have generators. The module comes first, then one controller for each endpoint of the app:

```sh
pnpm marmeon make:module notes
pnpm marmeon make:controller ListNotes --module=notes --request --view
pnpm marmeon make:controller CreateNote --module=notes
pnpm marmeon make:controller StoreNote --module=notes --request
pnpm marmeon make:controller EditNote --module=notes
pnpm marmeon make:controller UpdateNote --module=notes --request
pnpm marmeon make:controller PinNote --module=notes
pnpm marmeon make:controller UnpinNote --module=notes
pnpm marmeon make:controller DeleteNote --module=notes
```

`make:module` writes `modules/notes/index.ts` and an empty `modules/notes/routes.ts`, and adds the module last in `modules` of
`bootstrap/app.ts`. See [creating a module](modules.md#creating-a-module). `make:controller` adds `Controller` to the name and
writes the file into `controllers/`. `--request` adds the request next to the controller, with a query schema for a name that
starts with `List` and a body schema for the others. `--view` adds the page, named after the controller: `ListNotes` becomes
`views/ListNotes.tsx` and the page `notes/ListNotes`. See [creating a controller](controllers.md#creating-a-controller).

Each generated file is a starting point. The files below replace them one by one, so the order of this page is the order of the
explanation: until the last file is in place, `pnpm dev` and the type check may report a missing file or a type that does not fit
yet.

The framework has no generator for repositories, policies or the schema of a form. You write those files by hand, and this guide
shows each one. The form page is written by hand as well: one component serves the new note and the edit of one, so `CreateNote`
and `EditNote` come without `--view`.

## The table

```sh
pnpm marmeon make:migration create_notes_table --module=notes
```

`make:migration` puts the current time into the file's name, so yours is called
`modules/notes/migrations/<year>_<month>_<day>_<time>_create_notes_table.ts` and looks different from the one below. Migrations
run in the order of their names. See [generating migrations](migrations.md#generating-migrations).

The command also adds the migrations folder to the module's `index.ts`. Set the module's definition to this:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
```

Replace the contents of the new migration with the table of the notes:

```ts title="modules/notes/migrations/2026_10_13_000000_create_notes_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 120);
      table.text('body');
      table.boolean('pinned').default(false);
      table.timestamps();
    }),
  down: (schema) => schema.drop('notes'),
});
```

`table.id()` is the primary key. `foreignId('user_id').constrained()` points at `users`, and `cascadeOnDelete()` removes a user's
notes with the user. `timestamps()` adds `created_at` and `updated_at`, which the repository sorts by. Read more under
[columns](migrations.md#columns) and [foreign keys](migrations.md#foreign-keys).

Create the table and write its types. This is the first thing you can see work:

```sh
pnpm marmeon migrate
pnpm marmeon db:types
```

`migrate` runs the migration and shows its name. `db:types` writes the types of the tables into `bootstrap/database.d.ts`, which
is where `Row<'notes'>` below comes from; in development `migrate` writes the file as well. See [running
migrations](migrations.md#running-migrations).

## The repository

A repository is the one class that reads and writes a table. It extends `Repository`, names its table, and gets the query builder
and the usual operations: `find`, `insert`, `update`, `delete`.

```ts title="modules/notes/NoteRepository.ts"
import { Repository, type PageRequest } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;

  /** One page of a user's notes: the pinned ones first, then the most recently changed. Only what the page shows. */
  pageOf(userId: number, page: PageRequest) {
    const query = this.query()
      .select(['id', 'title', 'body', 'pinned'])
      .where('user_id', '=', userId)
      .orderBy('pinned', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc');
    return this.paginate(query, page);
  }
}
```

`pageOf()` is the only query the app needs beyond those: one user's notes, the pinned ones first, as a page. The `select` list
names the columns the page shows, so nothing else reaches the browser. See [repositories](queries.md#repositories) and
[pagination](pagination.md#pages-by-number).

## Routes and controllers

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { CreateNoteController } from './controllers/CreateNoteController.ts';
import { DeleteNoteController } from './controllers/DeleteNoteController.ts';
import { EditNoteController } from './controllers/EditNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { PinNoteController } from './controllers/PinNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';
import { UnpinNoteController } from './controllers/UnpinNoteController.ts';
import { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Signed in, with a confirmed address. A note in the URL is looked up by its id and then checked
// against the signed-in user by NotePolicy: somebody else's note is a 404.
export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).middleware(verified()).name('notes.');

  // These three never take a note from the path: the list asks for `ctx.user.id`, and a new note is created for the signed-in user.
  const mine = notes.authorize(everyone);
  mine.get('/', ListNotesController).name('index');
  mine.get('/create', CreateNoteController).name('create');
  mine.post('/', StoreNoteController).name('store');

  const note = notes.bind('note', NoteRepository);
  note.get('/:note/edit', EditNoteController).name('edit');
  note.put('/:note', UpdateNoteController).name('update');
  note.put('/:note/pin', PinNoteController).name('pin');
  note.delete('/:note/pin', UnpinNoteController).name('unpin');
  note.delete('/:note', DeleteNoteController).name('destroy');
});
```

Every route of the module sits behind `authenticate()`, which sends a guest to the sign-in page, and `verified()`, which sends an
account without a confirmed address to the notice. Without `verified()`, an account registered with somebody else's address would
reach the notes. The prefix `/notes` and the name prefix `notes.` apply to all routes in the group. See [your own
pages](starter-kit.md#your-own-pages), [route groups](routing.md#route-groups) and [named routes](routing.md#named-routes).

`notes.bind('note', NoteRepository)` ties `:note` in a path to the repository. The controller receives the row, and a path whose
note does not exist answers 404. See [binding a repository](routing.md#binding-a-repository).

Every route says who may call it, or the app does not start. The note routes say it in their requests, with `can(NotePolicy, …)`
(next chapters). The list, the form and the store route take no note from the path, so `mine` marks them with `everyone`: they ask
for `ctx.user.id`, never for a note by its id. A route that binds a record and says `everyone` does not start. See [every route
decides](authorization.md#every-route-decides).

A controller is a class with a `handle()` method for one endpoint. The container builds it and injects what its constructor asks
for. Start with the list and the empty form:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const ListNotesRequest = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 10 }) }),
});

/** The signed-in user's notes, ten to a page, the pinned ones first. */
export class ListNotesController extends Controller {
  static request = ListNotesRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof ListNotesRequest> & Authenticated) {
    return this.view('notes/ListNotes', { notes: await this.#notes.pageOf(ctx.user.id, ctx.query) });
  }
}
```

`defineRequest()` states what the controller accepts, here the query string: `pageQuery()` reads `?page=` and fixes ten notes to a
page. `ContextOf<typeof ListNotesRequest>` types `ctx.query`, and `Authenticated` types `ctx.user`, which `authenticate()` has
set. The controller returns `this.view('notes/ListNotes', props)`: the page `modules/notes/views/ListNotes.tsx` with its props.
See [controllers](controllers.md#requests).

```ts title="modules/notes/controllers/CreateNoteController.ts"
import { Controller } from '@marmeon/http';

/** The empty form of a new note. */
export class CreateNoteController extends Controller {
  handle() {
    return this.view('notes/Form', { note: null });
  }
}
```

## The pages

The list page shows each note as a card, with the actions of the note below it. Replace `modules/notes/views/ListNotes.tsx`:

```tsx title="modules/notes/views/ListNotes.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link, Pagination, useTranslation } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

type Props = PageProps<ListNotesController>;

/** A note's body as paragraphs: a blank line starts a new one. */
const paragraphs = (body: string) => body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '');

export default function ListNotes({ notes }: Props) {
  const t = useTranslation('notes');
  return (
    <main className="app-main stack stack-loose">
      <Head title={t('index.title')} />
      <div className="cluster">
        <h1>{t('index.title')}</h1>
        <Link route="notes.create" className="button">
          {t('index.new')}
        </Link>
      </div>
      {notes.data.length === 0 && <p className="muted">{t('index.empty')}</p>}
      <div className="stack">
        {notes.data.map((note) => (
          <article key={note.id} className="card">
            <h2>
              {note.title}
              {note.pinned && (
                <>
                  {' '}
                  <span className="badge">{t('index.pinned')}</span>
                </>
              )}
            </h2>
            {paragraphs(note.body).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
            <div className="cluster">
              <Link route="notes.edit" params={{ note: note.id }} className="button-secondary" data-size="small">
                {t('index.edit')}
              </Link>
              {note.pinned ? (
                <Link route="notes.unpin" params={{ note: note.id }} className="button-secondary" data-size="small">
                  {t('index.unpin')}
                </Link>
              ) : (
                <Link route="notes.pin" params={{ note: note.id }} className="button-secondary" data-size="small">
                  {t('index.pin')}
                </Link>
              )}
              <Link
                route="notes.destroy"
                params={{ note: note.id }}
                className="button-secondary"
                data-size="small"
                data-destructive=""
                confirm={{ title: t('index.delete_title', { name: note.title }), message: t('index.delete_confirm'), confirmLabel: t('index.delete'), destructive: true }}
              >
                {t('index.delete')}
              </Link>
            </div>
          </article>
        ))}
      </div>
      <Pagination
        meta={notes.meta}
        labels={{
          navigation: t('index.pagination'),
          previous: t('index.previous'),
          next: t('index.next'),
          page: (page) => t('index.page', { page }),
        }}
      />
    </main>
  );
}

ListNotes.layout = AppLayout;
```

`PageProps<ListNotesController>` gives the props that the controller's `view()` call passes. `<Link route="…">` takes a route
name, and the type check refuses a name that does not exist or `params` that the path does not need. The pin and unpin links use
`PUT` and `DELETE` routes, and `<Link>` sends those as forms. The delete link carries `confirm`, which opens a dialog first. See
[links that send](navigation.md#links-that-send) and [asking the user](dialogs.md#asking-the-user).

The classes come from the starter kit: `.card` for a box, `.button` and `.button-secondary` for actions, `.badge` for the "Pinned"
mark, `.muted` for quiet text, `.stack` and `.cluster` for vertical and horizontal spacing. The pages set no `style` attribute,
which the app's content security policy would refuse. See [no `style` attributes](styling.md#no-style-attributes).

The form page serves both routes, the new note and the edit of one. Create `modules/notes/views/Form.tsx`:

```tsx title="modules/notes/views/Form.tsx"
import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, useTranslation, type FormFieldsOf, type FormRenderState } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { CreateNoteController } from '../controllers/CreateNoteController.ts';
import type { EditNoteController } from '../controllers/EditNoteController.ts';

type Props = PageProps<CreateNoteController> | PageProps<EditNoteController>;

export default function NoteForm({ note }: Props) {
  const t = useTranslation('notes');
  const title = note ? t('form.edit_title') : t('form.new_title');
  // The same fields for both routes: `notes.update` takes what `notes.store` takes.
  const fields = (form: FormRenderState<FormFieldsOf<'notes.store'>>) => (
    <>
      <div className="field">
        <label htmlFor="title">{t('form.title')}</label>
        <input id="title" defaultValue={note?.title} maxLength={120} {...form.field('title')} />
        {form.error('title') && <small role="alert">{form.error('title')}</small>}
      </div>
      <div className="field">
        <label htmlFor="body">{t('form.body')}</label>
        <textarea id="body" rows={8} defaultValue={note?.body} maxLength={10_000} {...form.field('body')} />
        {form.error('body') && <small role="alert">{form.error('body')}</small>}
      </div>
      <div className="cluster">
        <button type="submit" className="button" disabled={form.processing}>
          {t('form.save')}
        </button>
        <Link route="notes.index" className="button-secondary">
          {t('form.cancel')}
        </Link>
      </div>
    </>
  );

  return (
    <main className="app-main stack stack-loose">
      <Head title={title} />
      <h1>{title}</h1>
      <section className="card">
        {note ? (
          <Form route="notes.update" params={{ note: note.id }} className="stack" guard={t('form.unsaved')}>
            {fields}
          </Form>
        ) : (
          <Form route="notes.store" className="stack" guard={t('form.unsaved')}>
            {fields}
          </Form>
        )}
      </section>
    </main>
  );
}

NoteForm.layout = AppLayout;
```

`<Form route="notes.store">` posts to a route by its name and takes its field names from that route's validation, so
`form.field('title')` and `form.error('title')` are typed. `.field` groups a label, an input and the error under it. The `guard`
text asks before the user leaves with unsaved changes. See [forms](forms.md#forms-by-route-name).

The texts of both pages live in language files next to the module, in English and German:

```ts title="modules/notes/lang/en.ts"
/** The texts of the notes — the source language. `lang/de.ts` is checked against this file. */
const en = {
  nav: 'Notes',
  index: {
    title: 'Your notes',
    new: 'New note',
    empty: 'You have no notes yet.',
    pinned: 'Pinned',
    pin: 'Pin',
    unpin: 'Unpin',
    edit: 'Edit',
    delete: 'Delete',
    delete_title: 'Delete {name}?',
    delete_confirm: 'The note is gone for good.',
    pagination: 'Pages of notes',
    previous: 'Previous',
    next: 'Next',
    page: 'Page {page}',
  },
  form: {
    new_title: 'New note',
    edit_title: 'Edit note',
    title: 'Title',
    body: 'Note',
    save: 'Save',
    cancel: 'Back to your notes',
    unsaved: 'You have unsaved changes. Leave this page?',
  },
  flash: {
    created: 'Note saved.',
    updated: 'Note updated.',
    deleted: 'Note deleted.',
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    notes: typeof en;
  }
}
```

```ts title="modules/notes/lang/de.ts"
import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

/** Die Texte der Notizen auf Deutsch — ein fehlender Schlüssel oder Platzhalter ist ein Compilerfehler. */
export default {
  nav: 'Notizen',
  index: {
    title: 'Deine Notizen',
    new: 'Neue Notiz',
    empty: 'Du hast noch keine Notizen.',
    pinned: 'Angeheftet',
    pin: 'Anheften',
    unpin: 'Lösen',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    delete_title: '{name} löschen?',
    delete_confirm: 'Die Notiz ist danach endgültig weg.',
    pagination: 'Seiten der Notizen',
    previous: 'Zurück',
    next: 'Weiter',
    page: 'Seite {page}',
  },
  form: {
    new_title: 'Neue Notiz',
    edit_title: 'Notiz bearbeiten',
    title: 'Titel',
    body: 'Notiz',
    save: 'Speichern',
    cancel: 'Zurück zu deinen Notizen',
    unsaved: 'Es gibt ungespeicherte Änderungen. Seite verlassen?',
  },
  flash: {
    created: 'Notiz gespeichert.',
    updated: 'Notiz aktualisiert.',
    deleted: 'Notiz gelöscht.',
  },
} satisfies Messages<typeof en>;
```

`useTranslation('notes')` reads the keys of `lang/en.ts`, and the `declare module` block types every one of them. A key missing
from `de.ts` fails the type check. See [localization](localization.md#language-files).

The navigation lives in the auth module's layout, so the link to the notes is an edit of an existing file, in two places. First,
load the notes' texts in `modules/auth/layouts/AppLayout.tsx`, below the line that reads `const user = …`:

```tsx title="modules/auth/layouts/AppLayout.tsx"
  const user = auth?.user ?? null;
  const notes = useTranslation('notes');
```

Then add the link below the dashboard link in the navigation:

```tsx title="modules/auth/layouts/AppLayout.tsx"
            <Link route="dashboard">{t('layout.dashboard')}</Link>
            <Link route="notes.index" activeMatch="notes.*">
              {notes('nav')}
            </Link>
```

`activeMatch="notes.*"` marks the link as current on every page whose route name starts with `notes.`.

## Validation

A form sends two fields, and a note without a title is not a note. The fields are a schema, which the store and the update
controllers share:

```ts title="modules/notes/noteFields.ts"
import { rules as r } from '@marmeon/validation';

/** What a note's form sends: a title, and a body that may stay empty. Nothing else — the owner is the signed-in user. */
export const noteFields = r.object({
  title: r.string().trim().required().max(120),
  body: r.string().max(10_000),
});
```

`title` is trimmed, required and at most 120 characters, which is also the width of the column. `body` may be empty. A field the
schema does not name never reaches the controller, so a form that sends a `user_id` changes nothing. See
[validation](validation.md#objects).

```ts title="modules/notes/controllers/StoreNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { noteFields } from '../noteFields.ts';

export const StoreNoteRequest = defineRequest({ schema: noteFields });

/** Saves a new note for the signed-in user. */
export class StoreNoteController extends Controller {
  static request = StoreNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof StoreNoteRequest> & Authenticated) {
    await this.#notes.insert({ user_id: ctx.user.id, title: ctx.body.title, body: ctx.body.body });
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.created') });
  }
}
```

`schema` in `defineRequest()` validates the body before `handle()` runs. When it fails, the user returns to the form with the
errors and the input, and the controller does not run. `handle()` reads `ctx.body`, typed from the schema, and the owner of the
new note is `ctx.user`, never a field of the form. The redirect carries a flash message, which the layout shows as a toast. See
[validated input](requests.md#validated-input) and [flash messages](pages.md#flash-messages).

## Only your own notes

Route binding finds a note by its id, whoever owns it. A policy decides whether the signed-in user may touch it:

```ts title="modules/notes/policies/NotePolicy.ts"
import { denyAsNotFound, type AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

/**
 * A note belongs to the person who wrote it. Anyone else gets the answer of a note that does not exist, so nobody can
 * probe the ids of other people's notes.
 */
export class NotePolicy {
  update(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || denyAsNotFound();
  }

  delete(user: AuthUser, note: Row<'notes'>) {
    return note.user_id === user.id || denyAsNotFound();
  }
}
```

A policy is a class with one method per ability. `denyAsNotFound()` answers 404, the answer for a note that does not exist,
instead of 403. That way nobody can probe which ids exist. See [writing policies](authorization.md#writing-policies).

> [!WARNING]
> Every route that takes a `:note` needs the policy. A route bound to the repository alone finds any user's note, and the
> controller would show it.

A controller asks the policy through its request: `authorize: can(NotePolicy, 'update', 'note')` runs the `update` method with the
user and the bound `note` parameter. The check runs before the validation, so a stranger who sends an invalid form gets the 404
and no error messages about fields. See [the order of a request](controllers.md#the-order-of-a-request). The other controllers of
the module work the same way:

```ts title="modules/notes/controllers/EditNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const EditNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** The form of one of the user's notes — somebody else's note answers 404 before this runs. */
export class EditNoteController extends Controller {
  static request = EditNoteRequest;

  handle(ctx: ContextOf<typeof EditNoteRequest>) {
    const { id, title, body } = ctx.params.note;
    return this.view('notes/Form', { note: { id, title, body } });
  }
}
```

`ctx.params.note` is the row that the binding found. The controller takes the three columns the form needs out of it, so the page
gets no others. See [pages](responses.md#pages).

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { noteFields } from '../noteFields.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UpdateNoteRequest = defineRequest({ schema: noteFields, authorize: can(NotePolicy, 'update', 'note') });

/** Saves the changes to one of the user's notes. */
export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { title: ctx.body.title, body: ctx.body.body });
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.updated') });
  }
}
```

```ts title="modules/notes/controllers/PinNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const PinNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** Pins a note — `PUT`, so pinning it twice is the same as once. */
export class PinNoteController extends Controller {
  static request = PinNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof PinNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { pinned: true });
    return this.back('/notes');
  }
}
```

```ts title="modules/notes/controllers/UnpinNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UnpinNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** Unpins a note. */
export class UnpinNoteController extends Controller {
  static request = UnpinNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UnpinNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { pinned: false });
    return this.back('/notes');
  }
}
```

```ts title="modules/notes/controllers/DeleteNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const DeleteNoteRequest = defineRequest({ authorize: can(NotePolicy, 'delete', 'note') });

/** Deletes one of the user's notes. */
export class DeleteNoteController extends Controller {
  static request = DeleteNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DeleteNoteRequest>) {
    await this.#notes.delete(ctx.params.note.id);
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.deleted') });
  }
}
```

Pinning is a `PUT` and unpinning a `DELETE` on the same path. `PUT` sets a state, so the second pin leaves the note as the first
one did. See [every route decides](authorization.md#every-route-decides).

## Run it

The module is complete. One command is left: it writes the names of the routes into `bootstrap/routes.ts`, which is how `<Link
route="notes.index">` becomes checked.

```sh
pnpm marmeon route:types
```

`pnpm dev` keeps the file up to date while it runs, so you need the command only without it, as in a build script. See [typed
route names](routing.md#typed-route-names).

With `pnpm dev` running, sign in and open http://localhost:3000/notes.

## Tests

The tests of a module sit next to it. Each one boots the app on a fresh database, acts as a user and sends requests through the
real middleware, controllers and pages:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory, UserRepository } from '../auth/index.ts';
import type { ListNotesController } from './controllers/ListNotesController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Who may see and change which note.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const notes = () => app.make(NoteRepository);

describe('the notes', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page', async () => {
    await app.get('/notes').assertRedirect('/login');
    await app.get('/notes/create').assertRedirect('/login');
    await app.post('/notes', { form: { title: 'Hello', body: '' } }).assertRedirect('/login');
  });

  it('lists only the notes of the signed-in user, the pinned ones first', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await notes().insert({ user_id: ada.id, title: 'Groceries', body: 'Milk' });
    await notes().insert({ user_id: ada.id, title: 'Ideas', body: 'Many', pinned: true });
    await notes().insert({ user_id: bob.id, title: 'Secret', body: 'Not for Ada' });

    await app.actingAs(ada).navigating().get('/notes').assertPage<ListNotesController>('notes/ListNotes', (props) => {
      expect(props.notes.data.map((note) => note.title)).toEqual(['Ideas', 'Groceries']);
      expect(props.notes.meta.total).toBe(2);
    });
  });

  it('pages the list', async () => {
    const ada = await app.factory(UserFactory).create();
    for (let number = 1; number <= 12; number++) await notes().insert({ user_id: ada.id, title: `Note ${number}`, body: '' });
    await app.actingAs(ada).navigating().get('/notes?page=2').assertPage<ListNotesController>('notes/ListNotes', (props) => {
      expect(props.notes.data).toHaveLength(2);
      expect(props.notes.meta.lastPage).toBe(2);
    });
  });

  it('creates a note for the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/notes/create').assertPage('notes/Form', { note: null });
    await app.actingAs(ada).post('/notes', { form: { title: '  Groceries  ', body: 'Milk' } }).assertRedirect('/notes');
    expect(await notes().firstWhere({ user_id: ada.id })).toMatchObject({ title: 'Groceries', body: 'Milk', pinned: false });
  });

  it('keeps a note for the signed-in user whatever the form says', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/notes', { form: { title: 'Mine', body: '', user_id: String(bob.id) } }).assertRedirect('/notes');
    expect(await notes().findBy('title', 'Mine')).toMatchObject({ user_id: ada.id });
  });

  it('refuses a note without a title, with a title that is too long or with a body that is', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/notes', { form: { title: ' ', body: 'x' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/notes', { form: { title: 'x'.repeat(121), body: '' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/notes', { form: { title: 'Long', body: 'x'.repeat(10_001) } }).assertRedirect().assertInvalid(['body']);
    expect(await notes().count()).toBe(0);
  });

  it('changes a note', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Draft', body: '' });
    await app.actingAs(ada).navigating().get(`/notes/${note.id}/edit`).assertPage('notes/Form', { note: { id: note.id, title: 'Draft', body: '' } });
    await app.actingAs(ada).put(`/notes/${note.id}`, { form: { title: 'Final', body: 'Done' } }).assertRedirect('/notes');
    expect(await notes().find(note.id)).toMatchObject({ title: 'Final', body: 'Done' });
    await app.actingAs(ada).put(`/notes/${note.id}`, { form: { title: '', body: '' } }).assertRedirect().assertInvalid(['title']);
  });

  it('pins a note and unpins it again', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Important', body: '' });
    await app.actingAs(ada).put(`/notes/${note.id}/pin`).assertRedirect();
    await app.actingAs(ada).put(`/notes/${note.id}/pin`).assertRedirect();
    expect((await notes().find(note.id))!.pinned).toBe(true);
    await app.actingAs(ada).delete(`/notes/${note.id}/pin`).assertRedirect();
    expect((await notes().find(note.id))!.pinned).toBe(false);
  });

  it('deletes a note', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Obsolete', body: '' });
    await app.actingAs(ada).delete(`/notes/${note.id}`).assertRedirect('/notes');
    expect(await notes().find(note.id)).toBeUndefined();
  });

  it("answers 404 for somebody else's note, however it is reached", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: bob.id, title: 'Secret', body: 'Not for Ada' });
    const ada404 = app.actingAs(ada);
    await ada404.get(`/notes/${note.id}/edit`).assertNotFound();
    await ada404.put(`/notes/${note.id}`, { form: { title: 'Mine now', body: '' } }).assertNotFound();
    await ada404.put(`/notes/${note.id}/pin`).assertNotFound();
    await ada404.delete(`/notes/${note.id}/pin`).assertNotFound();
    await ada404.delete(`/notes/${note.id}`).assertNotFound();
    await ada404.get('/notes/999999/edit').assertNotFound();
    expect(await notes().find(note.id)).toMatchObject({ title: 'Secret', pinned: false });
  });

  it('deletes the notes with their user', async () => {
    const ada = await app.factory(UserFactory).create();
    await notes().insert({ user_id: ada.id, title: 'Gone with Ada', body: '' });
    await app.make(UserRepository).deleteAccounts([ada.id]);
    expect(await notes().count()).toBe(0);
  });
});
```

`app.actingAs(user)` signs a user in for the requests that follow. `assertRedirect`, `assertPage`, `assertInvalid` and
`assertNotFound` check the response. The test "answers 404 for somebody else's note, however it is reached" matters most: a note
of another user answers 404 on every route, and its row stays as it was. See [testing](testing.md) and [HTTP
tests](http-tests.md).

```sh
pnpm test
pnpm lint
```

## Build and start

```sh
pnpm build
NODE_ENV=production pnpm marmeon start
```

`build` checks the types, including the route names in your pages, and bundles the browser's files. `start` serves the build. It
runs in production, and refuses a `NODE_ENV=development` that comes from `.env` alone: the `.env` of the starter kit says
`development`, so set `NODE_ENV=production` in the shell to try the build on your machine, and a server sets its own `NODE_ENV`.
See [building and starting](deployment.md#building-and-starting).

## Where to go next

- [Authentication](authentication.md) and [authorization](authorization.md) go further than the starter kit's sign-in.
- [Two-factor authentication](two-factor-authentication.md#setting-up) and [passkeys](passkeys.md#setting-up) add a second factor.
- [UUID keys](migrations.md#uuid-keys) keep sequential ids out of your URLs, if you want them.
- [Queries](queries.md) covers relations, filters and transactions beyond a single table.
- [Pagination](pagination.md) shows cursors, searching and sorting for longer lists.
- [Forms](forms.md) covers live validation, uploads and remembered input.
- [Localization](localization.md) adds a language.
- [Deployment](deployment.md) takes the app to a server.
