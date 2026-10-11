# Pages & Layouts

## Introduction

A page is a React component in a module's `views/` folder. A controller names it with `this.view()` and hands it its props, and
the page takes the types of those props from the controller:

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

The server renders the page into the first document, and the browser takes it over from there. Later visits fetch only the next
page's props and swap the page in place, while the layout around it stays. This page covers views, layouts, the document head,
shared props, flash messages and translations in the browser. The [responses](responses.md#pages) page covers the controller's
side.

## Writing pages

### Where pages live

A page's name is its path below `views/`, prefixed with the module: `modules/notes/views/Show.tsx` is `notes/Show`, and
`modules/notes/views/settings/Sharing.tsx` is `notes/settings/Sharing`. The page is the file's default export.
`marmeon make:controller ShowNote --module=notes --view` writes a controller and its page in one go.

Only files under `modules/<module>/views/` of the app are pages. A path with `::` is reserved for the pages of packages
(`package::Page`): `marmeon route:types`, and with it `marmeon build`, fails and names each such file, and the app never
registers such a page, neither in the browser nor in server rendering. Rename the file or its folder.

A name with no file behind it is a compile error in the controller, because `marmeon route:types` lists every view in
`bootstrap/routes.ts`. Each page is a chunk of its own, loaded the first time the browser shows it.

### Props

`PageProps<ShowNoteController>` is what the controller's `this.view()` hands the page, plus the [shared props](#shared-props).
Props travel as JSON, so a `Date` arrives as a string. A view imports its controller with `import type`, which keeps the
controller's code on the server.

### What a page may import

The browser runs your pages, their layouts and everything they import. Import values only from the browser's
entries of the framework, such as `@marmeon/react`, `@marmeon/react/table`, `@marmeon/http/page`, `@marmeon/http/client` and
`@marmeon/i18n/messages`, from your own client modules and from npm packages made for the browser. Types may come from
anywhere, as long as the import says `import type`, because the compiler erases it:

```tsx
import type { PageProps } from '@marmeon/http';                                 // a type: erased
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';  // a type: erased
import { Head, Link } from '@marmeon/react';                                      // values for the browser
```

A value import of a controller, a repository, a job or another server module fails the build and shows an error in development.
The [asset bundling](vite.md#server-code-in-the-browser) page lists what counts as a server module.

## Layouts

### Defining a layout

A layout is a component around pages. It gets the page as `children`:

```tsx title="layouts/AppLayout.tsx"
import { Link, type LayoutProps } from '@marmeon/react';

export function AppLayout({ children }: LayoutProps) {
  return (
    <>
      <header className="app-header">
        <Link route="notes.index">Notes</Link>
      </header>
      {children}
    </>
  );
}
```

### The default layout

The app's default layout wraps every page that does not choose its own. Both entries take it, so the server and the browser render
the same markup. Keep it in one file that both import:

```ts title="bootstrap/layouts.ts"
import type { DefaultLayout } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

export const layout: DefaultLayout = () => AppLayout;
```

`bootstrap/client.tsx` passes it as `createMarmeonApp({ layout })` and `bootstrap/ssr.tsx` as
`createSsrRenderer(resolvePage, { layout })`. The function gets the page's name, so it can choose by module:
`(name) => (name.startsWith('auth/') ? null : AppLayout)`. `null` means no layout. A new app has no default layout: the starter
kit's pages set their own.

### A page's own layouts

A page names its layouts with a static `layout`, outermost first:

```tsx title="modules/notes/views/settings/Sharing.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, type PageLayout } from '@marmeon/react';
import { AppLayout } from '../../../../layouts/AppLayout.tsx';
import type { ShowSharingController } from '../../controllers/ShowSharingController.ts';
import { SettingsLayout } from '../../layouts/SettingsLayout.tsx';

export default function Sharing({ note }: PageProps<ShowSharingController>) {
  return (
    <section>
      <Head title={`Sharing ${note.title}`} />
      <h2>Who can read this note</h2>
    </section>
  );
}

Sharing.layout = [AppLayout, SettingsLayout] satisfies PageLayout;
```

A page's own `layout` wins over the default, and `Sharing.layout = null` renders the page without any. `satisfies PageLayout` lets
the compiler check the value. A value that is not a component throws when the page loads, with the code `R1`.

### Layouts that stay

A layout that the next page has too, at the same depth, stays mounted while you navigate. Its state survives the visit: an open
menu stays open, a scrolled sidebar keeps its position, and the layout does not render from scratch. In the example above, moving
between two settings pages keeps both `AppLayout` and `SettingsLayout`, and only the page inside them changes.

## Shared props

Props that a middleware shares with `SharedData` reach every page. Any component reads them with `usePage()`, a layout included:

```tsx title="layouts/AppLayout.tsx"
import { Link, usePage, type LayoutProps } from '@marmeon/react';

export function AppLayout({ children }: LayoutProps) {
  const user = usePage().props.auth?.user ?? null;
  return (
    <>
      <header className="app-header">
        {user ? <Link route="notes.index">{user.name}'s notes</Link> : <Link route="auth.login">Sign in</Link>}
      </header>
      {children}
    </>
  );
}
```

`usePage()` returns the page on screen: its `component`, `props`, `url`, `locale` and `flash`. Inside a layer it returns the
layer's page. The props are typed by `interface SharedProps`, which the middleware declares. The
[responses](responses.md#shared-props) page shows how to share a prop.

Declare shared props as optional and render without them. A path that matches no route passes no group's middleware, so its 404
page has no shared props, yet it still renders inside the default layout.

## The document head

`<Head>` sets the page's title and adds `<meta>` and `<link>` tags to the document head:

```tsx
<Head title={note.title}>
  <meta name="description" content={note.body.slice(0, 150)} />
</Head>
```

The server renders the head into the first document, and the browser keeps it current on every visit. When a layout and a page
both set a title, the last one rendered wins, which is the page.

The title goes through the app's title template, which both entries take as `title`:

```ts title="bootstrap/head.ts"
import type { TitleTemplate } from '@marmeon/react';

export const title: TitleTemplate = (page) => (page ? `${page} — Notes` : 'Notes');
```

A page without a `<Head title>` gets `title('')`. When that is empty, the `<title>` of `index.html` stays. An island cannot change
the head: a `<Head>` inside one throws in development and renders nothing in production.

## Flash messages

A controller flashes a message with `.flash('toast', { … })`, and the browser shows it once. A layout listens with `useFlash()`:

```tsx title="layouts/Toasts.tsx"
import { useFlash, usePage } from '@marmeon/react';
import { useState } from 'react';

export function Toasts() {
  const [toasts, setToasts] = useState<readonly { id: string; message: string }[]>([]);
  useFlash('toast', (toast, { id }) => setToasts((current) => [...current, { id, message: toast.message }]));
  const { flash } = usePage();
  return (
    <>
      <noscript>
        {flash?.filter((message) => message.key === 'toast').map((message) => <p key={message.id}>{message.data.message}</p>)}
      </noscript>
      <section aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id}>{toast.message}</p>
        ))}
      </section>
    </>
  );
}
```

The handler runs exactly once per message, after the answer that brought it is on screen. That answer can be a page, a partial
reload, a layer or an action. Back, Forward and a page shown from memory never fire it again. The key and the shape of its data
come from `interface FlashData`, so a wrong key is a compile error.

`useFlash()` runs in the browser only. On the server, the page's `flash` list is there for a `<noscript>`, so a browser without
JavaScript still sees the message. The [responses](responses.md#flash-data-and-flash-messages) page shows how to flash one.

## Translations

`useTranslation()` gives the texts of a namespace in the page's language. A namespace is a module's name, or `app` for the files
in `lang/`:

```tsx title="modules/notes/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function Index({ notes, now }: PageProps<ListNotesController>) {
  const t = useTranslation('notes');
  return (
    <main>
      <Head title={t('index.title')} />
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <Link route="notes.show" params={{ note: note.id }}>{note.title}</Link>{' '}
            <small>{t('index.edited', { when: t.format.relative(note.updated_at, now) })}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Keys and placeholders are checked against the file that declares the namespace in `interface Translations`, usually the
module's English file, `modules/notes/lang/en.ts`. `t.format` formats numbers,
dates and relative times in the page's locale. `useLocale()` gives `{ locale, format }` where you need no texts.

The browser loads only the files of the page's locale, before the page renders. Both entries need the app's messages as
`messages`, which a new app already passes. Format a date against a time the server sends, such as a `now` prop, so that the
server and the browser render the same text. The [localization](localization.md) page covers language files and switching the
language.

## Server rendering

Every page renders on the server first. The response streams: the page's frame goes out at once, and parts that wait for data
follow in the same response. A page can change that with a static `ssr`:

| `ssr` | What the server sends |
| --- | --- |
| `true` | The page, streamed. The default. |
| `'complete'` | The whole page at once, when everything is rendered. |
| `false` | No markup. The browser renders the page. |

Search engines and link previews always get the whole page at once. `SSR_ENABLED=false` turns server rendering off for every
page.

The browser hydrates the server's markup, so both must render the same thing. Values that differ between the two, such as
`Date.now()`, `Math.random()` or a check for `window`, make React render that part again. In development the console and a
notice on the page name the page. Render such values in an effect, pass them as props, or set `ssr = false` on the page.

## The entries

An app has two entries. `bootstrap/client.tsx` starts the app in the browser, and `bootstrap/ssr.tsx` renders pages on the server.
They take the same values, so keep those in `bootstrap/` and import them in both:

```tsx title="bootstrap/client.tsx"
import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

void createMarmeonApp({ resolve: resolvePage, title, routes, layout, messages, progress: progressBar({ delay: 250 }) });
```

```tsx title="bootstrap/ssr.tsx"
import { createSsrRenderer } from '@marmeon/react/server';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage, { title, routes, layout, messages });
```

`resolvePage` comes from `resolveModulePages(pages)`, with `pages` from `virtual:marmeon/pages`. These are the options:

| Option | Client | Server | What it does |
| --- | --- | --- | --- |
| `resolve` | yes | first argument | Finds a page's component by its name. |
| `routes` | yes | yes | The routes the browser knows, for `<Link route>`, `useRoute()` and forms. |
| `layout` | yes | yes | The [default layout](#the-default-layout). |
| `title` | yes | yes | The [title template](#the-document-head). |
| `messages` | yes | yes | The language files. Only the page's locale is loaded. |
| `layer` | yes | yes | The frame around every [dialog](dialogs.md). Default `LayerDialog`. |
| `progress` | yes | | An indicator of visits under way. None by default. See [navigation](navigation.md#showing-that-a-visit-runs). |
| `confirm` | yes | | The dialog that asks before a link, an action or a form goes ahead. Default: the browser's `confirm()`. |
| `tabSync` | yes | | `false` turns tab sync off. See [client features](client-features.md#turning-it-off). |
| `viewTransition` | yes | | Animates every page change. See [navigation](navigation.md#view-transitions). |
| `rootId` | yes | | The element the server rendered into. Default `app`. |
| `onRecoverableError` | yes | | Errors React recovered from while hydrating. Default: the console, and in development a notice on the page. |

`createMarmeonApp()` reads the page from the document, loads its component and the texts of its locale, and then hydrates. When
the document has no markup, because the page has `ssr = false` or rendering failed on the server, it renders the page instead.

## The error page

An error while a page renders shows the page `errors/Error` inside its layouts. A built-in one is there until you write
`modules/errors/views/Error.tsx`. The [error handling](errors.md#your-own-error-page) page shows how.

## Testing

A page test visits the route and checks the page's name and props, typed by its controller. The
[testing pages](testing-pages.md) page covers it, with server rendering and hydration.
