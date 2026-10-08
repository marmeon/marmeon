# Dialogs & Layers

## Introduction

A layer is a page that opens over the page on screen, as a modal or a slide-over, instead of replacing it. It has its own route,
its own controller and its own history entry: Back closes it, and a link to its URL shows it over the page it belongs to. The
controller says that its view is a layer, and names that page as its base:

```ts title="modules/notes/controllers/EditNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class EditNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    return this.view('notes/Edit', { note: { id: note.id, title: note.title, body: note.body } }).layer({
      base: 'notes.show',
      params: { note: note.id },
    });
  }
}
```

A link with `layer` opens it over whatever is on screen:

```tsx
<Link route="notes.edit" params={{ note: note.id }} layer>Edit</Link>
```

The page beneath stays as it was, with its scroll position, its islands and whatever the user typed into it. This page covers
opening layers, what a view can do inside one, forms that close their layer, and the dialog that asks the user a question.

## Opening a layer

### The base

`.layer({ base, params, query, key })` turns a page into a layer. `base` names the route that shows under the layer when its URL is
opened directly: a link from an e-mail, a reload, a bookmark. The name and its parameters are checked like a link's. The base is a
page, or another layer, whose own base then comes next.

For such a deep link, the server runs the base's route in the same request, with its own middleware and authorization, and sends
the base with the layer over it. When the user may not see the base, because its route redirects, refuses or fails, the layer
shows alone over an empty surface inside the app's layout. Nothing of the base is computed for the browser then.

> [!WARNING]
> A base resolved for a deep link only reads. Its middleware and controller cannot write the session, set a cookie or queue work
> after the response, and it takes no flash message. In development and in tests such a write throws a `ReadOnlyViolation`. In
> production it is dropped and logged, so a base route that records something works as a page and loses the write as a base. Keep
> writes in the layer's own route or in an action.

### The link

`<Link route layer>` takes only routes whose controller answers with a layer, and any other route is a compile error. The flag
also loads the code of the layers as soon as the link renders, so the layer opens without a wait. Any visit whose answer is a layer
opens it over the page on screen, with the flag or without it: then the code loads when the answer arrives. A page that never shows
a layer never downloads it.

A link inside a layer opens the next layer over it. Layers stack up to ten deep, and an answer that would open an eleventh shows as
a page. That is when `useLayer().isLayer` is `false` for a layer's view, besides a controller that renders the same view without
`.layer()`.

## Inside a layer

`useLayer()` tells a view about the layer it is in. The same view can be a page and a layer, so check `isLayer` before you close
anything:

```tsx title="modules/notes/views/Edit.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useLayer } from '@marmeon/react';
import type { EditNoteController } from '../controllers/EditNoteController.ts';

export default function Edit({ note }: PageProps<EditNoteController>) {
  const layer = useLayer<EditNoteController>();
  const form = useForm('notes.update', { note: note.id }, { title: note.title, body: note.body }, { guard: true });
  const Heading = layer.isLayer ? 'h2' : 'h1';
  return (
    <section>
      <Head title="Edit note" />
      <Heading>Edit note</Heading>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <input value={form.data.title} onChange={(event) => form.set('title', event.target.value)} autoFocus={layer.isLayer} />
        <button disabled={form.processing}>Save</button>{' '}
        {layer.isLayer ? (
          <button type="button" onClick={() => void layer.close()}>Cancel</button>
        ) : (
          <Link route="notes.show" params={{ note: note.id }}>Cancel</Link>
        )}
      </form>
    </section>
  );
}
```

| Member | What it is |
| --- | --- |
| `isLayer` | Whether the view is shown as a layer. `false` when it renders as a page. |
| `depth` | 1 for the first layer over the page, 2 for one over that, 0 for a page. |
| `isTop` | Whether it is the topmost layer, the one that takes the keyboard. |
| `key` | Its identity in the stack. An answer with the same key replaces it in place. |
| `once` | Whether it is the answer of an action. See [answers that open a layer](#answers-that-open-a-layer). |
| `close({ reload })` | Closes it, and the layers over it. `reload` then reloads what is beneath: some props, or `true` for all. |
| `onClose(listener)` | Runs once the layer has left the screen. Returns the function that stops listening. |

`useLayer({ onClose })` takes the listener as an option. Visits, forms and actions inside a layer belong to it: `usePage()` returns
the layer's page, and `useRouter()` reloads and patches the layer's props.

## Forms that close their layer

A form inside a layer is sent as the layer's request. When the input is invalid, the answer replaces the layer in place, with the
errors. When it succeeds, the controller closes the layer with `closeLayer()`:

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { NoteRepository } from '../NoteRepository.ts';

export const UpdateNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().min(1).max(120), body: r.string().max(10_000) }),
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
    return this.closeLayer({ reload: ['note'] })
      .route('notes.show', { note: ctx.params.note.id })
      .flash('toast', { kind: 'success', message: 'Note saved.' });
  }
}
```

The browser closes the layer, then reloads the `note` prop of what is beneath, and the toast fires at once. `reload: true` reloads
every prop, and `layers: 2` closes the layer and the one beneath it. A request that does not come from a layer gets a redirect
instead: to the route named with `.route()`, or back to where the form was. That covers a form sent without JavaScript and the
view opened as a page.

## Answers that open a layer

A form's answer can be a layer too. Its key decides whether it replaces the layer that sent the form or opens over it. Here a layer
asks whom to share a note with, and the answer, a link that works only once, replaces it under the same key:

```ts title="modules/notes/controllers/ShareNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';
import { ShareLinks } from '../ShareLinks.ts';

export const ShareNoteRequest = defineRequest({
  schema: r.object({ days: r.integer().between(1, 30) }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export const SHARE_LAYER = { base: 'notes.show', key: 'notes.share' } as const;

export class ShareNoteController extends Controller {
  static request = ShareNoteRequest;

  readonly #links: ShareLinks;

  constructor(links: ShareLinks) {
    super();
    this.#links = links;
  }

  async handle(ctx: ContextOf<typeof ShareNoteRequest>) {
    const { note } = ctx.params;
    const url = await this.#links.create(note.id, ctx.body.days);
    return this.view('notes/ShareLink', { url }).layer({ ...SHARE_LAYER, params: { note: note.id } });
  }
}
```

The layer with the form returns `.layer({ ...SHARE_LAYER, params: { note: note.id } })` as well, so both share the key
`notes.share`. A layer that answers a `POST`, `PUT`, `PATCH` or `DELETE` is shown once. When it leaves the screen, it is gone from
the tab's memory, and what is beneath reloads, because the action changed it. Forward then sends a `GET` to the layer's URL and
shows that answer, so give that URL a `GET` route: in the example, the share form's. That suits a secret
shown once: it never sits in the session, and it does not come back from memory.

## Back, Forward and closing

Opening a layer writes a history entry. Back closes the top layer from memory: the page beneath does not render again, and its
deferred props and islands are not asked for again. Forward opens the layer again from memory. `close()` goes back in the history
when the layer was opened right over what is beneath, and replaces the entry otherwise.

A layer with unsaved changes asks before it closes, as a page does before the user leaves it. The
[navigation](navigation.md#leaving-with-unsaved-changes) page explains the guard. A visit to another page takes every layer off the
screen, and signing out drops them with the pages.

## The frame

The frame around every layer is `LayerDialog` by default: a native `<dialog>`, opened modally. The browser keeps the focus inside
it and makes the page beneath inert. Escape, the close button and a click on the backdrop close it, and the focus returns to the
link that opened it. The dialog is named by the view's first heading, and described by an element with `data-layer-description`.

Wrap the frame to word its close button in your app's language, and pass it to both entries as `layer`:

```tsx title="layouts/LayerFrame.tsx"
import { LayerDialog, useTranslation, type LayerFrameProps } from '@marmeon/react';

export function LayerFrame(props: LayerFrameProps) {
  const t = useTranslation('app');
  return <LayerDialog {...props} closeLabel={t('close')} className="app-layer" />;
}
```

A view chooses its look with a static `layer`: `'modal'`, the default, `'slideover'`, or a frame component of its own:

```tsx
Edit.layer = 'slideover';
```

The frame's look comes from `@marmeon/react/styles.css`, which the [styling](styling.md) page lists. `LayerDialog` also takes a
`style` prop, for a value such as a CSS variable. It applies that prop in the browser after the dialog has mounted, so the
server's markup carries no `style` attribute, and a layer opened by a deep link shows without it until the page has hydrated.

## Asking the user

Links, forms and actions take `confirm`, and the navigation guard asks before unsaved changes are left. The app's confirm dialog
asks those questions. Without one, the browser's `confirm()` and `prompt()` ask. The starter kit passes `ConfirmDialog`, worded in
the page's language:

```tsx title="bootstrap/confirm.tsx"
import { ConfirmDialog, useTranslation, type ConfirmProps } from '@marmeon/react';

export function Confirm(props: ConfirmProps) {
  const t = useTranslation('app');
  const session = props.request.reason === 'session';
  return (
    <ConfirmDialog
      {...props}
      request={session ? { ...props.request, message: t('confirm.session') } : props.request}
      confirmLabel={t('confirm.ok')}
      cancelLabel={t('confirm.cancel')}
      leaveLabel={t(session ? 'confirm.reload' : 'confirm.leave')}
      stayLabel={t('confirm.stay')}
      promptLabel={(text) => t('confirm.prompt', { text })}
    />
  );
}
```

`bootstrap/client.tsx` passes it as `createMarmeonApp({ confirm: Confirm })`. `ConfirmDialog` is a native modal `<dialog>` whose
focus starts on the safe choice. A request's own `confirmLabel` and `cancelLabel` win over the dialog's. `request.kind` is
`confirm` for a question of a link, a form or an action, and `leave` for the guard's. A `leave` with `reason: 'session'` means that
another tab signed in or out, or switched the language, and loading the page again would lose the unsaved changes.

With `prompt`, the user must type a text: `confirm={{ message: 'Delete the folder?', prompt: 'DELETE' }}`. The answer is yes only
for exactly that text, and the framework compares it, not the dialog. A dialog of your own is a component that takes
`ConfirmProps`: it shows `request` and calls `answer(true)`, `answer(false)` or `answer(text)`.
