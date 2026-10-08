# Actions

## Introduction

An action is a request that does not navigate: pin a note, delete a row, mark a message read. The page stays, the URL stays, and
the answer comes back to the component that sent it. `useAction()` takes a route's name and is typed by it:

```tsx title="modules/notes/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, useAction, useRouter } from '@marmeon/react';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function Index({ notes }: PageProps<ListNotesController>) {
  const router = useRouter<ListNotesController>();
  const destroy = useAction('notes.destroy');

  const remove = (id: number) =>
    void destroy.submit({
      params: { note: id },
      confirm: { message: 'Delete this note?', destructive: true },
      optimistic: router.optimistic((props) => ({ notes: props.notes.filter((note) => note.id !== id) })),
      reload: router.reloading({ only: ['notes'] }),
    });

  return (
    <main>
      <Head title="Notes" />
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            {note.title} <button type="button" onClick={() => remove(note.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

The note disappears at once. When the server confirms, the list reloads in the background. When it refuses, the note comes back.
An action is an ordinary request of its route, so its middleware, CSRF protection, authorization and validation run as for a form.

## The controller

An action's controller answers with data or with a redirect, never with a page:

```ts title="modules/notes/controllers/DestroyNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { NoteRepository } from '../NoteRepository.ts';

export const DestroyNoteRequest = defineRequest({
  authorize: can(NotePolicy, 'delete', 'note'),
});

export class DestroyNoteController extends Controller {
  static request = DestroyNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof DestroyNoteRequest>) {
    await this.#notes.delete(ctx.params.note.id);
    return this.json({ deleted: ctx.params.note.id }).flash('toast', { kind: 'success', message: 'Note deleted.' });
  }
}
```

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { DestroyNoteController } from './controllers/DestroyNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { PinNoteController } from './controllers/PinNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).middleware(verified()).name('notes.');
  notes.get('/', ListNotesController).name('index');

  const note = notes.bind('note', NoteRepository);
  note.post('/:note/pin', PinNoteController).name('pin');
  note.delete('/:note', DestroyNoteController).name('destroy');
});
```

`this.json(data)` is what the action's result carries, typed. A redirect is reported to the component, not followed. A flash
message on either goes to the browser with the answer and fires once, as a toast. A route whose controller renders a page, and an
island's route, are compile errors in `useAction()`:

```text
'notes.index' answers with a page — visit it (<Link>, useForm); an action's controller returns this.json(…) or a redirect
```

## Sending

`submit()` takes what the call sends and what it does on screen:

| Option | Effect |
| --- | --- |
| `params` | The route's parameters. Required when its path has required ones, unless `useAction(name, params)` bound them. |
| `data` | The body, typed by the route's request schema. A route without a schema takes none. |
| `query` | The query of a `GET` route, typed by its query schema. |
| `optimistic` | Patches of the page shown at once. See [optimistic updates](#optimistic-updates). |
| `reload` | What reloads once the call succeeded. See [reloading](#reloading-after-an-action). |
| `confirm` | Asks first. A no sends nothing, and the call ends `cancelled`. |
| `key` | A newer call with the same key cancels the older one, so the last click of a toggle wins. |
| `onRedirect` | `'visit'` follows the controller's redirect. By default it is only reported. |

Calls run side by side, each with its own patches. A body with a file goes as `multipart/form-data`.

## The result

`submit()` resolves with how the call ended, and never rejects because a request failed:

```tsx
const pin = useAction('notes.pin');
const result = await pin.submit({ params: { note: note.id } });
if (result.ok && result.kind === 'data') console.log(result.data.pinned);
```

| `kind` | `ok` | What happened |
| --- | --- | --- |
| `data` | `true` | The controller answered `this.json(…)`. `data` is that value as JSON made it. |
| `redirect` | `true` | The controller redirected. `redirect` is the URL. |
| `invalid` | `false` | The request schema refused the input. `errors` has the first message per field. |
| `exception` | `false` | Offline, or a status such as 403, 404 or 500. `exception` says which. |
| `cancelled` | `false` | `cancel()`, a newer call with the same `key`, a no to `confirm`, or the page was left. |

`data` and `redirect` also carry the call's flash messages. The action itself keeps the state of its last call for rendering:

| Member | What it is |
| --- | --- |
| `pending` | A call is under way. |
| `submissions` | This component's calls under way, oldest first. |
| `result` | How the last finished call ended. |
| `data` | The data of the last call that answered with data. |
| `errors`, `hasErrors`, `clearErrors(...fields)` | The validation errors of the last call. |
| `exception` | Why the last call failed, until the next one. |
| `cancel()` | Aborts this component's calls under way and rolls back their patches. |

An action is never retried by itself. A 401 or 419 means the session is gone, for example after a sign-out in another tab: say so,
and let the user reload. When the answer says that the user signed out, the browser loads the page anew.

## Optimistic updates

`router.optimistic(patch)` describes how the page looks once the action has worked. The patch is a function of the page's props:

```tsx
const router = useRouter<ListNotesController>();
const pin = useAction('notes.pin');

void pin.submit({
  params: { note: note.id },
  optimistic: router.optimistic((props) => ({
    notes: props.notes.map((other) => (other.id === note.id ? { ...other, pinned: true } : other)),
  })),
  reload: router.reloading({ only: ['notes'] }),
});
```

The page shows the patch at once, over its props. A failed or cancelled call takes its patch out again, and only its own: several
patches on one list compose. The patch is checked against the props of `ListNotesController`, so a prop the page does not have is
a compile error.

A patch never changes what the tab keeps. The props in memory, the history and the browser's storage hold the server's answers
only. The patching code loads with the first `router.optimistic()` or `router.reloading()` of a page, so the first patch shows a
moment later and every later one at once.

## Reloading after an action

`router.reloading(options)` names what the page asks the server for again once the call succeeded. The reload runs in the
background, and the patches go in the same render the server's props land in:

```tsx
reload: router.reloading({ only: ['notes', 'counts'] }),
```

`only` and `except` take prop names, checked against the page. Name every prop the patches touch, so the server's answer replaces
them. Without options, every prop reloads. `islands: ['notes.recent']` reloads the islands of those routes on the page, and without
`only` or `except` it reloads only them.

What a reload brings replaces what the page has, also a list that was merged with "load more": a deleted row is gone, and the list
starts over at its first page. `router.reloading({ only: ['notes'], reset: [] })` merges instead. The [deferred props](deferred-props.md#merged-props) page explains
merged props.

## Ghost rows

`usePendingSubmissions(name)` lists the calls of a route under way, from every component, actions and route forms alike:

```tsx
const adding = usePendingSubmissions('notes.store');

{adding.map((call) => (
  <li key={`adding-${call.id}`} aria-busy="true">{call.input.title}</li>
))}
```

Each call has its `id`, its `input`, typed by the route's schema, its `method` and its `url`. A call stays listed until the props it
reloads have landed, so its row never blinks out before the real one is there. Nothing has to be rolled back.

## In a dialog or an island

Inside a [dialog](dialogs.md), `useRouter()` belongs to the dialog: `router.optimistic()` patches the dialog's props, and
`router.reloading()` reloads them. Inside an island, `useIsland()` has `optimistic()` and `reloading()` for the island's props:

```tsx
const island = useIsland<ShowRecentNotesController>();
const archive = useAction('notes.archive');
void archive.submit({ params: { note: id }, optimistic: island.optimistic((props) => ({ notes: props.notes.filter((n) => n.id !== id) })), reload: island.reloading() });
```

## What an action never does

An action writes no history entry and leaves the URL alone. Its answer is never cached, it shows no progress bar, and it fires no
visit events. It cannot run while a page renders on the server: `submit()` there throws.

Other tabs that show the same list do not learn about the change by themselves. A live update after the write reloads the list
there, which the [real time](realtime.md) page shows.
