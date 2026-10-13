# @marmeon/react

The React side of Marmeon apps: pages and layouts rendered on the server and hydrated in the browser, `<Link>`, forms, actions,
islands and dialogs — on the framework's UI-free client core.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

`react` and `react-dom` 19 are peers, never dependencies: the app and the framework must render with one React. TanStack Table
is an optional peer, for `@marmeon/react/table-tanstack` only: `pnpm add @tanstack/react-table@^9`.

## A page

```tsx title="modules/notes/views/Show.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';

export default function Show({ note }: PageProps<ShowNoteController>) {
  return (
    <main>
      <Head title={note.title} />
      <h1>{note.title}</h1>
      <p>{note.body}</p>
      <Link route="notes.index">All notes</Link>
    </main>
  );
}
```

The props are the controller's, typed from end to end. A view imports its controller as a type only, so no server code reaches
the browser.

## Documentation

- [Pages & Layouts](https://marmeon.com/docs/pages)
- [Navigation & View Transitions](https://marmeon.com/docs/navigation)
- [Forms](https://marmeon.com/docs/forms)
- [Actions](https://marmeon.com/docs/actions)
- [Dialogs & Layers](https://marmeon.com/docs/dialogs)
- [Deferred Props & Islands](https://marmeon.com/docs/deferred-props)
- [Client Features & Tab Sync](https://marmeon.com/docs/client-features)
- [Styling](https://marmeon.com/docs/styling)
- [Testing Pages](https://marmeon.com/docs/testing-pages)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
