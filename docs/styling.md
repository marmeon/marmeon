# Styling

## Introduction

A Marmeon app styles its pages with stylesheets and classes. The client entry imports the framework's stylesheet and your own, and
the build turns them into stylesheets that the document links:

```tsx title="bootstrap/client.tsx"
import { createMarmeonApp, progressBar } from '@marmeon/react';
import '../styles/app.css';
import '@marmeon/react/styles.css';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

void createMarmeonApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delayMs: 250 }) });
```

Pages and layouts name classes, never a `style` attribute. That keeps the app ready for a strict Content-Security-Policy, which
blocks every `style` attribute in the markup. This page covers where stylesheets go, why inline styles are out and what to do
instead, and the classes of the framework's own components.

## Your stylesheets

A stylesheet imported in `bootstrap/client.tsx` becomes part of the build: `marmeon build` writes it into a stylesheet that the
built `index.html` links, from your own origin. While you develop, the server links each stylesheet the client entry imports in the document's head, so a reload paints styled. A stylesheet that a lazily loaded module or a view imports still arrives when that module loads. The same holds for CSS modules (`*.module.css`, left out on purpose so their hot updates keep working) and for CSS that a dependency imports from its own code.

A stylesheet can also be linked from `index.html` directly, which Vite processes the same way in the build:

```html title="index.html"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Notes</title>
    <link rel="stylesheet" href="/styles/app.css" />
    <!--app-head-->
  </head>
  <body>
    <div id="app"><!--app-html--></div>
  </body>
</html>
```

A linked stylesheet applies before the entry runs, also in development. A module can bring its own stylesheet next to its views:
`marmeon make:auth` writes `modules/auth/auth.css` and imports it in `bootstrap/client.tsx`.

Web fonts are declared in a stylesheet like any other. To have the browser fetch the ones the first screen sets with the document,
name their files in the [`fonts` option](vite.md#fonts) of `marmeon()`. The same option gives a web font a
[fallback of matching size](vite.md#a-fallback-with-the-same-size), so the text barely moves when the font arrives.

The [starter kit](starter-kit.md#the-look) has a look of its own in plain CSS, with tokens you can change.

## No `style` attributes

A Content-Security-Policy can limit where styles come from. With `style-src 'self'`, the browser applies stylesheets of your origin
and ignores every `style` attribute in the server's markup. A nonce does not help, because it covers `<style>` and `<link>`
elements, never attributes. React does not add the attribute later either: when it hydrates, it takes the server's markup as it is.
So a `style` prop on a server-rendered element is lost under such a policy.

Write classes instead, and use data attributes for state:

```tsx
<p className="note-status" data-pinned={note.pinned || undefined}>{note.title}</p>
```

```css title="styles/app.css"
.note-status[data-pinned] { font-weight: 600; }
```

A value that only the page knows, such as a width in percent, goes into a CSS variable that you set through the CSSOM after the
element has mounted. The policy does not govern the CSSOM:

```tsx title="modules/notes/views/Progress.tsx"
import { useLayoutEffect, useRef } from 'react';

export function Progress({ done }: { done: number }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => bar.current?.style.setProperty('--done', `${done}%`), [done]);
  return <div ref={bar} className="progress" />;
}
```

```css title="styles/app.css"
.progress { width: var(--done, 0%); height: 4px; background: currentColor; }
```

The framework follows the same rule. Its components render no `style` attribute. `LayerDialog` takes a `style`
prop and applies it through the CSSOM after it has mounted. `ConfirmDialog` takes one too and renders in the browser only, where
React sets it through the CSSOM. The progress bar sets its properties through the CSSOM as well.

### A strict policy for styles

`contentSecurityPolicy()` in `bootstrap/app.ts` limits scripts and leaves styles alone by default. When your pages carry no `style`
attributes, limit styles too:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, NONCE, securityHeaders } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy({ styleSrc: ["'self'", NONCE] })],
  },
});
```

`'self'` allows the built stylesheets, and `NONCE` allows the `<style>` elements that Vite adds in development and that React adds
for streamed parts of a page. `styleSrc: ["'self'"]` alone blocks nothing of the framework in a build. The
[Content-Security-Policy](csp.md) page covers the other directives.

## The framework's look

`@marmeon/react/styles.css` styles the framework's components:

| Component | Classes |
| --- | --- |
| The form around a link that sends, `<Link>` to a `POST`, `PUT`, `PATCH` or `DELETE` route | `marmeon-link` |
| The dialog frame, `LayerDialog` | `marmeon-layer`, `marmeon-layer--modal`, `marmeon-layer--slideover`, `marmeon-layer__content`, `marmeon-layer__close` |
| The confirm dialog, `ConfirmDialog` | `marmeon-confirm`, `marmeon-confirm__title`, `marmeon-confirm__field`, `marmeon-confirm__actions` |
| A failed visit | `marmeon-failure--network` for the notice when the server cannot be reached, `marmeon-failure--server` for the dialog with the server's error page, `marmeon-failure__frame`, `marmeon-failure__close` |
| The built-in error page | `marmeon-error`, `marmeon-error__status`, `marmeon-error__title`, `marmeon-error__exception` |

Every rule stands in the cascade layer `marmeon` and inside it in `:where()`, so it has no specificity: a class of your own,
passed as `className`, overrides it when it has no layer or stands in a layer after `marmeon`, and so does a
rule on the components' data attributes: `[data-marmeon-layer]`, `[data-variant]`, `[data-marmeon-confirm]`, `[data-kind]`,
`[data-destructive]` and `[data-marmeon-failure]`. A modal dialog keeps its `margin: auto`, its backdrop and the look of its
buttons under a CSS reset, which removes the browser's own. The backdrop colour is `--marmeon-backdrop`, the colour of the
confirm button of a destructive question `--marmeon-confirm-danger`. The failure notices take their colours from variables, which you set on `:root`:

```css title="styles/app.css"
:root {
  --marmeon-failure-background: #1f2937;
  --marmeon-failure-color: #f9fafb;
  --marmeon-failure-dialog-background: Canvas;
  --marmeon-failure-dialog-color: CanvasText;
}
```

The progress bar reads `--marmeon-progress-color`, `--marmeon-progress-height` and `--marmeon-progress-z-index`. Without the import
of `styles.css`, the components are unstyled, and their look is yours.

### Cascade layers

A rule without a layer beats every rule in a layer, whatever its specificity, and of two layers the one that appeared first in
the CSS loses (for declarations without `!important`; with it the layer order reverses). So your own CSS without a layer wins over the framework's look, and so does a layer you declare after `marmeon`.

If you use layers of your own (Tailwind CSS puts its reset in `base` and its classes in `utilities`), name the order in the first
stylesheet that loads, before anything else, so that `marmeon` stands after the reset and before your components and utilities:

```css title="styles/app.css"
@layer theme, base, marmeon, kit, components, utilities;
```

Keep `kit` in the line when the app has the starter kit or `make:auth`'s `auth.css`: they put their rules in that layer, and a layer first named later would stand after `utilities`.

Import that stylesheet before `@marmeon/react/styles.css` in the client entry, so utilities beat the framework.

`styles.css` itself opens with `@layer base, marmeon;`. Without your line the layers stand in the order the stylesheets load.
When `styles.css` loads first, `marmeon` sits above a reset in `base` and below your components and utilities, which keeps the
confirm dialog's margin and buttons. When Tailwind's layers come first, `marmeon` is appended after `utilities` and beats
them until you declare the order.

A reset without a layer (`* { margin: 0 }`) beats the dialogs' margin and padding too. Put it in a layer before `marmeon`:

```css title="styles/app.css"
@layer reset, marmeon;
@import './reset.css' layer(reset);
```

An app that relied on the framework's rules beating its own layered CSS sees its rules win now. To get the old order back,
declare its layer before `marmeon`.

### With a utility framework

A utility framework such as Tailwind CSS puts its classes in a layer (`utilities`) and its reset in another (`base`). Its classes
only beat the framework's look and the starter kit's when `utilities` stands after `marmeon` and `kit`; its reset stays in `base`,
before them. So three things have to agree:

1. In `vite.config.ts`, the utility framework's plugin stands before `marmeon()`, so its CSS is handled before the framework's own: `plugins: [tailwindcss(), marmeon()]`.
2. The first stylesheet names the whole order, before its `@import`s:

   ```css title="styles/app.css"
   @layer theme, base, marmeon, kit, components, utilities;
   @import 'tailwindcss';
   ```

   Keep `kit` in the line in any app with `make:auth`'s `auth.css`; naming a layer that has no rules does nothing.
3. The client entry imports that stylesheet before `@marmeon/react/styles.css`, because the layer order is fixed by the first
   stylesheet that names a layer.

CSS without a layer beats every utility, whatever its specificity: a `* { margin: 0 }`, an element rule such as `a { color: … }`,
or a stylesheet imported without `layer()`. Put a reset in `base`, before `marmeon`. Put element rules in a layer that stands
after `kit` and before `utilities`, for instance `@import './elements.css' layer(components);`, or give them a layer in the file
with `@layer components { … }`. In an app with the starter kit, such rules also beat the kit's class rules: see
[the starter kit](starter-kit.md#the-look) for where element rules go.

## Styling state

The framework marks state with attributes, so the stylesheet can follow it:

| Attribute | Where | When |
| --- | --- | --- |
| `aria-current="page"`, `data-current` | A `<Link>` | It leads to the page on screen. |
| `data-pending` | A `<Link>`, a `<Form>` | Its visit or its request is under way. |
| `data-dirty` | A `<Form>` | A field differs from where the form started. |
| `aria-busy="true"` | `<html>` | A visit is under way. |
| `data-island`, `data-status` | The element around an `<Island>` | Always: the island's route, and its status, such as `loading` or `ready`. |
| `data-marmeon-layer`, `data-variant`, `data-depth` | A `LayerDialog` | Its key, `modal` or `slideover`, and its depth. |
| `data-marmeon-confirm`, `data-kind`, `data-destructive` | A `ConfirmDialog` | Always; `confirm`, or `leave` for the guard's question; the request is `destructive`. |

```css title="styles/app.css"
a[data-current] { font-weight: 600; }
html[aria-busy='true'] main { opacity: 0.6; transition: opacity 0.2s 0.25s; }
[data-island][data-status='loading'] { min-height: 4rem; }
```

Animations between pages live in the stylesheet as well. The [navigation](navigation.md#view-transitions) page shows them.
