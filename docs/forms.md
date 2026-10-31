# Forms

## Introduction

A form sends what the user typed to a route, and the route's request schema checks it. `useForm()` takes the route's name, so
the form knows its method, its URL and the types of its fields:

```tsx title="modules/notes/views/Edit.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { EditNoteController } from '../controllers/EditNoteController.ts';

export default function Edit({ note }: PageProps<EditNoteController>) {
  const form = useForm('notes.update', { title: note.title, body: note.body }, { params: { note: note.id } });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      <Head title="Edit note" />
      <input value={form.data.title} onChange={(event) => form.set('title', event.target.value)} aria-invalid={!!form.errors.title} />
      {form.errors.title && <p role="alert">{form.errors.title}</p>}
      <textarea value={form.data.body} onChange={(event) => form.set('body', event.target.value)} />
      <button disabled={form.processing || !form.isDirty()}>Save</button>
    </form>
  );
}
```

When the server rejects the input, the errors come back by field, and nothing the user typed is lost. When it succeeds, the
controller usually redirects, and the browser shows the next page. Forms come in two kinds: `useForm()` holds the fields in React
state, and `<Form>` reads them from the inputs, which also works without JavaScript.

## Forms by route name

### Fields and errors

`useForm(name, initial, options)` takes the route's name, the fields' first values and the options. The route's parameters are the
option `params`, and the compiler asks for it when the route has required parameters; a route without them takes
`useForm(name, initial)`. The fields are typed by the route's request schema, as `FormOf<UpdateNoteController>`
would type them, so a field the schema does not have is a compile error:

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { NoteRepository } from '../NoteRepository.ts';

export const UpdateNoteRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().min(1).max(120),
    body: r.string().max(10_000),
  }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, ctx.body);
    return this.redirect().route('notes.show', { note: ctx.params.note.id }).flash('toast', { kind: 'success', message: 'Note saved.' });
  }
}
```

A route whose controller has no request schema cannot type a form, and `useForm()` says so.

A field whose rule is a number rule (`r.integer()`, `r.number()`, `r.port()`) holds a `number` in the form, also inside an object or a
list. An empty input is `''`, or `null` where the field is nullable, and the server reads both as missing. A number input
therefore reads and writes the field like this:

```tsx
<input
  type="number"
  value={form.data.capacity}
  onChange={(event) => form.set('capacity', event.target.value === '' ? '' : event.target.valueAsNumber)}
/>
```

A required number has no empty state: the compiler refuses `''` for it. A field with `.default()` is always there in the form,
so `form.data.resource_ids` is a `number[]` without a `?? []`, and the field belongs in `initial`. The data of `useAction()`
stays as the request takes it, since an action has no first values.

A field whose rule is `r.boolean()` or `r.accepted()` holds a `boolean` in the form, also inside an object or a list, so a checkbox needs no cast:
`checked={form.data.agree}` and `onChange={(event) => form.set('agree', event.target.checked)}`. The form sends `true` or
`false`; the rules also take what a browser posts without JavaScript (`'on'` for a ticked box, a hidden `'0'` or `'1'`), see
[Validation](validation.md#available-rules). In the browser:

| Member | What it is |
| --- | --- |
| `data` | The fields as they are now. |
| `set(field, value)`, `setData(data)` | Change one field, or all of them. |
| `errors` | The first message per field, from the server. |
| `hasErrors`, `clearErrors(...fields)` | Whether there are errors, and clearing some or all. |
| `isDirty(path?)`, `dirty` | Whether anything differs from where the form started, or the field at `path`, and the list of paths that differ. |
| `reset(...fields)` | Back to the first values, all fields or some. |
| `processing` | The request is under way. |
| `progress` | How far the upload of a request with files is, or `null`. |
| `wasSuccessful`, `recentlySuccessful` | The last submit succeeded, and it did less than two seconds ago, for a short "Saved." |
| `submit(options)` | Sends the form with the route's method to its URL. |
| `method`, `url` | Where it goes. |

### Errors at nested and dynamic fields

`errors` is keyed by every path into the form's data, with dots: `errors.title`, `errors['address.city']`,
`errors['items.0.name']` for a list (a tuple of fixed length has only the positions it declares), and `` errors[`answers.${key}`] `` for a field of a record whose keys are not known beforehand.
A path the data cannot have, `errors['adress.city']`, is a compile error. `clearErrors(...)` takes the same paths.

The paths are typed up to eight levels deep: every name or index between the dots counts one level, so
`` errors['sections.0.fields.1.guest_label.de'] `` is six levels. A path deeper than that is not known to the compiler; read
the errors as plain strings: `(form.errors as Partial<Record<string, string>>)[path]`, which is `string | undefined`. A record that refers to itself (`parent`, `children`) is typed like any other data for five levels; past the fifth level, each
step back into it counts three levels. So `` errors['children.0.children.0.children.0'] `` compiles, and a name after it does not.

The key `_` holds a message that belongs to the form and to no field, such as a check over several fields that names none. Show
it above the form: `form.errors._`. A check that can say where the fault lies reports at that field instead, see
[`custom()` of an object](validation.md#objects). In `<Form>`, `error(name)` takes the names of the inputs (`items[0][name]`)
and `'_'`.

### Sending

`submit()` sends the fields as JSON, or as `multipart/form-data` when they hold a file, and keeps the scroll position. When the
answer is the same page with errors, the page keeps its state, so the form keeps what was typed. `submit()` takes callbacks and
the [visit options](navigation.md#link-options):

```tsx
void form.submit({
  onSuccess: () => form.reset('body'),
  onError: (errors) => console.warn(errors),
  onFinish: () => setOpen(false),
});
```

`submit()` sends what the form holds at that moment, including a `set()`, `setData()` or `reset()` earlier in the same handler,
so a button can decide a value and send it in one go (no `setTimeout` or `flushSync` between them):

```tsx
<button type="button" onClick={() => { form.set('status', 'published'); void form.submit(); }}>Publish</button>
```

`form.data` is the value of the last render; use `set()` per field when building on an earlier `set()`
(`form.set('a', 1); form.setData({ ...form.data, b: 2 })` drops `a`).

`onError` gets the first message per field. `onFinish` runs after every submit, whether it succeeded, failed or was cancelled.
After a successful submit, what was sent becomes where the form starts, so it is no longer dirty.

A validation error on the server sends the browser back with the errors and the input, which the
[validation](validation.md#from-schema-to-handler) page explains. The first message of each field lands in `form.errors`.

A request that fails, because the server cannot be reached or answers with a server error, leaves the page and everything typed
in place. The app shows the failure over the page, which the [error handling](errors.md#errors-in-the-browser) page describes, and
`onException` in the submit options hears it.

### Forms by controller

A form for a URL you build yourself takes the controller's type instead of a route name:

```tsx
const form = useForm<StoreNoteController>({ title: '', body: '' });
void form.post('/notes');
```

`useForm(initial)` returns a `FormHandle<StoreNoteController>`; type the prop of a component you hand the form to with it: `function NoteFields({ form }: { form: FormHandle<StoreNoteController> })`. `get`, `post`, `put`, `patch` and `delete` send it, and `submit(method, url)` takes the method. Live validation needs a route
name, so this kind of form has no `validate` option.

#### A component shared by two forms

A create and an edit form show the same fields. Type the component with the fields it shows, `FormPart<Controller, 'field' | …>`,
and any form that has those fields fits it, whatever else the form holds:

```tsx
function NoteFields({ form }: { form: FormPart<StoreNoteController, 'title' | 'body'> }) {
  return (
    <>
      <input value={form.data.title} onChange={(event) => form.set('title', event.target.value)} />
      {form.errors.title && <small>{form.errors.title}</small>}
      <textarea value={form.data.body} onChange={(event) => form.set('body', event.target.value)} />
    </>
  );
}

const create = useForm<StoreNoteController>({ title: '', body: '' });
const edit = useForm<UpdateNoteController>({ title: note.title, body: note.body, pinned: note.pinned });
// <NoteFields form={create} /> and <NoteFields form={edit} /> both type-check.
```

`form.errors` and `form.clearErrors()` of the part are keyed by its fields, their paths and `_`. The part has no `setData`, which would
replace the data of the whole form, and `reset()` without arguments resets the whole form. A form whose controller lacks one of the
fields, or has a field that cannot hold what the part's type allows, is an error where it is handed to the component; type the part
from the controller with the narrower field types. A route form (`useForm('notes.update', …)`) fits as well.

## Forms without state

`<Form>` reads its fields from the inputs inside it, any input with a `name`. The render function gets the form's state:

```tsx title="modules/notes/views/Create.tsx"
import type { PageProps } from '@marmeon/http';
import { Form, Head } from '@marmeon/react';
import type { CreateNoteController } from '../controllers/CreateNoteController.ts';

export default function Create({ folders }: PageProps<CreateNoteController>) {
  return (
    <main>
      <Head title="New note" />
      <Form route="notes.store" resetOnSuccess>
        {(form) => (
          <>
            <input {...form.field('title')} placeholder="Title" />
            {form.error('title') && <p role="alert">{form.error('title')}</p>}
            <textarea {...form.field('body')} />
            {folders.map((folder) => (
              <label key={folder.id}>
                <input type="checkbox" {...form.field('folders[]')} value={folder.id} /> {folder.name}
              </label>
            ))}
            <button disabled={form.processing}>Create</button>
          </>
        )}
      </Form>
    </main>
  );
}
```

`form.field(name)` gives `name` and, while the field has an error, `aria-invalid`. The names are the route's fields in bracket
notation, checked by the compiler: `title`, `folders[]` for a list of values, `links[0][url]` for a list of objects. Spread it onto
any input, a component library's included. `form.error(name)` is the field's first message.

The state has `errors`, `hasErrors`, `processing`, `progress`, `wasSuccessful`, `recentlySuccessful`, `isDirty(name)`,
`validating(name)`, `submit()`, `reset()` and `clearErrors()`. The form carries `data-pending` while it is sent and `data-dirty`
while a field differs. `resetOnSuccess` empties the fields again after a success, as a create form wants. A form with an upload
field needs `useForm()` instead, as [uploads](#uploads) explains.

The button that sends the form adds its own `name` and `value`, so a row of buttons can be one field:

```tsx
<Form route="locale.update">
  {(form) => locales.map((code) => <button key={code} {...form.field('locale')} value={code}>{code}</button>)}
</Form>
```

### Without JavaScript

`<Form>` renders a real `<form>`. Before the app has started, or without JavaScript, the browser sends it by itself:

- A `GET` route's form writes its fields into the URL. Only a route with a query schema can take such a form, so a field never
  lands in a URL by accident.
- Any other route's form posts its fields. `PUT`, `PATCH` and `DELETE` travel as a hidden `_method` field.
- The page's CSRF token goes along as `_token`, when the page has one.

The [CSRF protection](csrf.md#forms-and-javascript) page explains when the token is needed. A `useForm()` form has no such
fallback, because its fields live in React.

## Validating while typing

A route form can check its fields against the server's schema while the user fills them in:

```tsx
const form = useForm('notes.update', { title: note.title, body: note.body }, { params: { note: note.id }, validate: true });

<input
  value={form.data.title}
  onChange={(event) => form.set('title', event.target.value)}
  onBlur={() => form.validate('title')}
  aria-busy={form.validating('title') || undefined}
/>
```

By default a field is checked when the user leaves it: call `form.validate('title')` in `onBlur`. A field that shows an error is
checked again while it is typed into, so fixing it clears the message. `{ on: 'change', debounceMs: 300 }` checks while typing, after
a pause, and `fields` limits the check to some fields. `form.validating(field)` says that a check is under way. `<Form validate>`
does the same, and calls the check on blur by itself. A form for a `GET` route has nothing to validate live, so `validate` does
nothing there.

The check is the form's own request with a header that names the fields. The route's middleware, its bindings, `authorize` and the
schema run, but never the controller. Fields that look like a secret are never sent, in the body or in the header: passwords, card numbers and security codes, one-time codes, tokens, secrets and keys, by the same names that keep them out of flashed and remembered input. Naming one in `fields` or in `form.validate()` is a type error, so check it when the form is sent. Files are not sent either. Database rules such as `unique()` and
your own async rules never answer while typing, so a form cannot be used to find out which addresses have an account. The
[validation](validation.md#live-validation) page covers the server's side and the rate limit. The checking code loads with a
form's first change, so an app that never validates live never downloads it.

## Unsaved changes

`guard` asks before the user leaves a form with unsaved changes, through the app's dialog:

```tsx
const form = useForm('notes.update', { title: note.title, body: note.body }, { params: { note: note.id }, guard: 'Discard your changes?' });
```

`true` asks with the default question. `<Form guard>` works the same way. The form's own submit passes its guard. The
[navigation](navigation.md#leaving-with-unsaved-changes) page lists what the guard can stop and what it cannot.

## Remembering input

`remember` keeps what was typed across Back and Forward. Leave the page, come back, and the input and its errors are still there:

```tsx
const form = useForm('notes.update', { title: note.title, body: note.body }, { params: { note: note.id }, remember: true });
```

The input stays in the tab's memory with the history entry, under the key `form:<route name>`. A string sets another key. A
reload, signing in or out and a new build start over. Fields named like a password and files are never kept, and neither is
any `<input type="password">` or a control with `autocomplete="one-time-code"`, `current-password` or `new-password`, whatever
its name; `include` does not change that. Fields named like a token, a secret, a credential, an API or private key, a session id, a recovery or one-time code (`otp`,
`code`, `recovery_code`, `sms_code`), a card or a bank account (`card_number`, `cvc`, `iban`), and controls with
`autocomplete="cc-*"`, are left out unless `{ include: [...] }` names them. A field that has been a password input stays out
even if a show-password toggle makes it plain text. A zip, postal, language, currency or promo code is kept. Remembered input in the browser keeps this fixed list; the names you add with `redact.keys` reach the server's flashed input only. `<Form remember>` works the same way, and a form by
controller takes a key: `useForm<StoreNoteController>(initial, { remember: 'new-note' })`.

## Asking first

`<Form confirm>` asks before it sends, through the app's dialog:

```tsx
<Form route="notes.archive" params={{ note: note.id }} confirm={{ message: 'Archive this note?', prompt: note.title, destructive: true }}>
  <button>Archive</button>
</Form>
```

With `prompt`, the answer is yes only when the user types exactly that text. A no sends nothing. The
[dialogs](dialogs.md#asking-the-user) page shows the dialog that asks and how to word it in your app's language. A `useForm()`
form asks with the `confirm` option of `submit()`.

## Uploads

A file field uploads the chosen file at once, before the form is sent. Write a form with an upload field with `useForm()`:
`<Form>` cannot bind `<FileInput>`, and a file it posts with its fields is refused. The form then sends a token in its place. The
route's schema marks the field with `upload()`:

```ts title="modules/notes/controllers/UpdateCoverController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Storage, upload } from '@marmeon/storage';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UpdateCoverRequest = defineRequest({
  schema: r.object({ cover: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateCoverController extends Controller {
  static request = UpdateCoverRequest;

  readonly #storage: Storage;
  readonly #notes: NoteRepository;

  constructor(storage: Storage, notes: NoteRepository) {
    super();
    this.#storage = storage;
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateCoverRequest>) {
    const key = await ctx.body.cover.store(this.#storage.disk('public'), 'covers'); // a random name: keep it
    await this.#notes.update(ctx.params.note.id, { cover_path: key });
    return this.redirect().route('notes.show', { note: ctx.params.note.id });
  }
}
```

`<FileInput>` binds an input to the field of a route form:

```tsx title="modules/notes/views/Cover.tsx"
import type { PageProps } from '@marmeon/http';
import { FileInput, useForm } from '@marmeon/react';
import type { ShowCoverController } from '../controllers/ShowCoverController.ts';

export default function Cover({ note }: PageProps<ShowCoverController>) {
  const form = useForm('notes.cover.update', { cover: null }, { params: { note: note.id } });
  const cover = form.data.cover;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      {cover?.preview && <img src={cover.preview} alt="" width={96} height={96} />}
      <FileInput field={form.field('cover')} accept="image/png,image/jpeg,image/webp" />
      {cover?.uploading && <progress value={cover.progress} max={1} />}
      {cover?.uploading && <button type="button" onClick={() => cover.cancel()}>Cancel</button>}
      {(form.errors.cover ?? cover?.error) && <p role="alert">{form.errors.cover ?? cover?.error}</p>}
      <button disabled={cover?.status !== 'uploaded' || form.processing}>Save</button>
    </form>
  );
}
```

The field holds the upload: its `status` (`uploading`, `uploaded` or `failed`), `progress` from 0 to 1, a `preview` URL of the
chosen image, an `error` and `cancel()`. The upload's target comes from the form's own route, so its middleware and `authorize`
decide who may upload, and the `upload()` rule sets the limit. On submit, the server checks the file again by its size and by its
first bytes. The [requests](requests.md#files) page covers the server's side. `store()` names the file itself and returns the
key, so the controller keeps it in the record. The [storage](storage.md#replacing-a-file) page shows how to replace a cover and
delete the old file in the right order, and how to keep a file private until its record is published.

`useUpload(form.field('cover'))` returns a function that uploads a `File` you have, for a drop zone or a cropped image. Uploads
need JavaScript, because the upload field accepts only the token of a file uploaded ahead. The upload code loads when the first
`<FileInput>` renders.

## Testing

A form test sends the request the form would send and checks the redirect, the errors and the database. The
[HTTP tests](http-tests.md#assertions) page covers it.
