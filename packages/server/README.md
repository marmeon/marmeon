# @bespokecore/server

The HTTP kernel (Hono for matching, the BespokeCore router for the typed pipeline), server rendering through Vite in
development and the build in production, islands and layers resolved in-process, `startServer()` with a graceful drain.
This README covers what the kernel reports and the development error page; the rest follows with the docs app.

## The request log line

Every request writes one entry on the `http` channel — `GET /users/7 200` with `{ requestId, route: 'users.show', ms }`
(`route` only for a named route). The kernel answers with the request's id (`x-request-id`, taken from the request when it
is a sane one, else generated); every log entry of the request carries it.

## Observation (E118)

The kernel traces each request on the `http.request` channel of `@bespokecore/core/diagnostics` — method, path, route name
and pattern, controller, status, duration — and sends the error a request ends in to `exception`; server rendering goes to
`render.ssr`. Without a subscriber none of it is built. See the core README for the channels and their messages.

## `Server-Timing` (E129) — development only

With `NODE_ENV=development` (`bespoke dev` sets it when it is unset) every response says what its request spent:

```text
Server-Timing: app;dur=18.4;desc="App", db;dur=3.1;desc="4 queries", ssr;dur=9.7;desc="SSR"
```

`app` is the request until its response (for a streamed page: until the shell), `db` the time of its queries and how many,
`ssr` server rendering until the shell (only when the page rendered on the server). The browser's network panel shows it
per request (Timing tab). It is **only** on with `NODE_ENV=development` — not in tests, not in staging, never in production
(E115: development tools check for development, never for "not production"). Its provider (`ServerServiceProvider`)
listens to `db.query` and `render.ssr` from its boot to its shutdown; elsewhere the channels keep no subscriber and no
header is set.

## Error page (E119) — development only

With `NODE_ENV=development` (`bespoke dev`), a page request that fails with a 5xx gets the **development error page** instead
of the app's `errors/Error` view:

- **head:** status, error class, message (and causes), the request and its route — and the **solutions** (E130): what to do,
  why, a command to copy, the README to read;
- **stack:** the app's frames first, each with its code (±8 lines, the throwing line marked) and an *open in editor* link
  (Vite's `/__open-in-editor`); Node runs the TypeScript as written and the injection transform keeps every line, so the
  line is the line that threw;
- **request** (method, URL, headers, query, body), **route** (name, pattern, controller, middleware, parameters), the
  request's **queries** (up to 100, with their duration) and **log** entries, **injection warnings** (E128), the
  **environment** (Node, `NODE_ENV`, the BespokeCore packages);
- **Copy as Markdown:** the same report as Markdown, for an issue or a chat (no source code, only where the frames are).

Everything on it — page and Markdown — passes the app's `Redactor` first (E125): cookies, `Authorization`, passwords,
tokens, hashes and the parameters of statements on secret columns never show.

It is one self-contained HTML document — its own CSS (light and dark), no React, no Vite, no app code — so it renders when
the views or server rendering are what broke. A client-side visit (`x-bespoke`) gets it as HTML too; the visit dialog
(`VisitFailure`) shows it in its sandboxed frame. The frame runs no scripts (`sandbox=""`, unchanged): there the Markdown is a
text field to select, and the editor links work through a named frame inside the page. A JSON request keeps `{ message,
exception }` and gets the first `solution` beside them. 4xx errors, actions, islands and uploads keep their answers; an app's
own `ExceptionHandler` keeps its own answer unless it renders the error page.

**Server-rendering errors** still fall back to rendering in the browser — and, in development, go to **Vite's overlay** with
the code frame of the view (mapped to the source by `ssrFixStacktrace`) and their solutions: to the tabs connected now
(`hot.send`) and into the failed document itself (Vite keeps an error for a tab only while no tab is connected).

**Only in development** (E115): the gate is `ServerConfig.debug` — `NODE_ENV === 'development'`, never "not production". In
production, staging or tests nothing of it is loaded (the kernel `import()`s the page's code only in debug mode), the
request recorder is not bound and subscribes to nothing, and the error page shows neither stack nor queries, headers or code.
Tests ask for it with `createTestApp(app, { debug: true })`.
