# Shop

Notes of the app: Zahlungen laufen über „Billing“ — nie direkt.

<!-- marmeon:begin v1 -->
Managed by `marmeon agents:sync` — edits inside this block are replaced; write yours outside.

Run `marmeon` through your package manager (`pnpm exec marmeon`, `npx marmeon`).
Pass `--no-interaction` to `marmeon` when you run it in a terminal.

## Documentation

- https://marmeon.com/docs — every page is also served as Markdown: add `.md` to the page's path, before any `#`.
- https://marmeon.com/llms.txt — the index of the pages, for agents.

## After a change

- `marmeon check` runs the type check, the lint and the checks of the app; run the tests too.
- `marmeon migrate` after a migration; it writes `bootstrap/database.d.ts`.
- `marmeon route:types` after a route changed; it writes `bootstrap/routes.ts`.
- Use a generator (`marmeon make:controller`, `marmeon make:migration`, …) before writing by hand; `marmeon list` shows every command.
- `marmeon publish` lists what each package lacks (without a terminal it only lists, and ends with 1 when something is missing); `marmeon publish <package>` copies them, then `marmeon migrate`; `marmeon publish --check` belongs in CI. Never point a module's `migrations` at `node_modules`.
- `marmeon-stubs.json` records where the files of `create-marmeon` and `make:auth` come from — do not edit it.

## Rules

- Every route decides who may call it: `authorize` on the request, or `Route.authorize(…)` on the registrar.
- Expected failures are `Result`s: check `.ok` before `.value`.
- No `sql.raw` or `sql.lit` with input.
- No import from `@marmeon/*/internal`.
- Your own stores (auth, sessions) extend the abstract base class (`SignInStore`, `SessionStore`, …), never a `Database…` class.
- An error carries `[marmeon:XX]`: look the code up at https://marmeon.com/docs/errors#server-error-codes. In development the last
  error is in `.marmeon/last-error.md`.
<!-- marmeon:end -->

## This app

More notes after the block.
