/**
 * The version of the marks that fence the block (`<!-- marmeon:begin v1 -->`). It names the shape of the marks, not the state of
 * the text between them, which changes with the release. A file marked with a newer version is left alone. See docs/agents.md#the-marks.
 */
export const AGENTS_BLOCK_FORMAT = 1;

/** The marks, one per line. */
export const AGENTS_BEGIN = `<!-- marmeon:begin v${AGENTS_BLOCK_FORMAT} -->`;
export const AGENTS_END = '<!-- marmeon:end -->';

/**
 * What `marmeon agents:sync` keeps between the marks of an app's `AGENTS.md`, marks included, with `\n` line ends. It has this
 * one source: the starter writes no copy of it.
 */
export const AGENTS_BLOCK = `${AGENTS_BEGIN}
Managed by \`marmeon agents:sync\` — edits inside this block are replaced; write yours outside.

Run \`marmeon\` through your package manager (\`pnpm exec marmeon\`, \`npx marmeon\`).
Pass \`--no-interaction\` to \`marmeon\` when you run it in a terminal.

## Documentation

- \`node_modules/marmeon/docs/\` holds the guides of the version you installed: \`marmeon docs\` lists them, \`marmeon docs <page>\`
  prints one. A \`docs/<page>.md\` in what \`marmeon\` prints is a file there.
- For a task — a resource, a public page or form, a background job — start with its
  recipe: \`marmeon docs\` lists them under "Recipes"; each names the generators, the files and the test.
- https://marmeon.com/docs is the newest version — read it to update; for your code, use the guides above.
  Add \`.md\` to a page's path for Markdown (https://marmeon.com/llms.txt is the index).

## After a change

- \`marmeon check\` runs the type check, the lint and the checks of the app; run the tests too.
- \`marmeon migrate\` after a migration; it writes \`bootstrap/database.d.ts\`.
- \`marmeon route:types\` after a route changed; it writes \`bootstrap/routes.ts\`.
- \`marmeon make:resource <Name>\` for a new kind of record: table, policy, requests, controllers, pages and a test.
- Use a generator (\`marmeon make:controller\`, \`marmeon make:migration\`, …) before writing by hand; \`marmeon list\` shows every command.
- \`marmeon publish\` lists what each package lacks (without a terminal it only lists, and ends with 1 when something is missing); \`marmeon publish <package>\` copies them, then \`marmeon migrate\`; \`marmeon publish --check\` belongs in CI. Never point a module's \`migrations\` at \`node_modules\`.
- \`marmeon-stubs.json\` records where the files of \`create-marmeon\` and \`make:auth\` come from — do not edit it.

## Rules

- Every route decides who may call it: \`authorize\` on the request, or \`Route.authorize(…)\` on the registrar.
- Expected failures are \`Result\`s: check \`.ok\` before \`.value\`.
- No \`sql.raw\` or \`sql.lit\` with input.
- Fix what \`marmeon check\` finds. Only where the code is safe as it is, silence a \`raw-sql\`, \`inner-html\` or \`throttle\` finding with
  \`// marmeon-check-ignore <check>: <why it is safe>\` (docs/check.md#silencing-a-finding), and tell the user.
- No import from \`@marmeon/*/internal\`.
- Your own stores (auth, sessions) extend the abstract base class (\`SignInStore\`, \`SessionStore\`, …), never a \`Database…\` class.
- An error carries \`[marmeon:XX]\`: look the code up with \`marmeon docs errors\` (section "Server error codes"). In development the last
  error is in \`.marmeon/last-error.md\`.
${AGENTS_END}`;
