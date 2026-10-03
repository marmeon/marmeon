# @bespokecore/server

The HTTP kernel (Hono for matching, the BespokeCore router for the typed pipeline), server rendering through Vite in
development and the build in production, islands and layers resolved in-process, `startServer()` with a graceful drain.
This README covers what the kernel reports so far; the rest follows with the docs app.

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
