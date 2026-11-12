import type { SkillFolder } from './install.ts';

/**
 * The version of the marks that fence the block (`<!-- marmeon:begin v1 -->`). It names the shape of the marks, not the state of
 * the text between them, which changes with the release. A file marked with a newer version is left alone. See docs/agents.md#the-marks.
 */
export const AGENTS_BLOCK_FORMAT = 1;

/** The marks, one per line. */
export const AGENTS_BEGIN = `<!-- marmeon:begin v${AGENTS_BLOCK_FORMAT} -->`;
export const AGENTS_END = '<!-- marmeon:end -->';

/** What an app has installed, as far as the block of `AGENTS.md` is concerned. Found by `installedTools`. */
export interface AgentTools {
  /** The first folder of `SKILL_FOLDERS` that holds skills with the mark; absent when none does. */
  readonly skillFolder: SkillFolder | undefined;
  /** The names of the marked skills in `skillFolder`. Only ever compared with names the package ships, never printed. */
  readonly skills: ReadonlySet<string>;
  /** `.mcp.json` has an entry `marmeon`. */
  readonly mcp: boolean;
}

/** An app with nothing installed. */
export const NO_TOOLS: AgentTools = { skillFolder: undefined, skills: new Set(), mcp: false };

/** The skills the package ships and the task each one is for, in the order the block lists them. */
const SKILL_USES: readonly (readonly [name: string, use: string])[] = [
  ['marmeon-feature-module', 'a new feature — a record with pages, a form, an endpoint or a background job.'],
  ['marmeon-page', 'a page, a form with validation errors, an island.'],
  ['marmeon-migration', 'any change to the database schema.'],
  ['marmeon-testing', 'the tests for a route, controller, policy, job or module.'],
  ['marmeon-debugging', 'a 500, an error `[marmeon:XX]`, a failing test or command — before you change code.'],
  ['marmeon-security-review', 'a review before a pull request that touches routes, policies, queries, tables or forms.'],
];

const HEADS = {
  both: ["## Skills and MCP tools", "This app has the framework's skills and the MCP server `marmeon`. Start a task with them; the commands below cover the\nrest."],
  skills: ['## Skills', "This app has the framework's skills. Start a task with them; the commands below cover the rest."],
  mcp: ['## MCP tools', 'This app has the MCP server `marmeon`. Start a task with its tools; the commands below cover the rest.'],
} as const;

const MCP_POINT = `- The MCP server \`marmeon\` reads the app for you: \`app_overview\` first (modules, providers, jobs, events, schedules), \`routes\`,
  \`schema\`, \`migrations\`, \`database\`, \`commands\` (CLI commands and options), \`query\` (one read-only SQL query); \`last_error\` (the last
  5xx) and \`devtools_entries\` (requests, queries, mails, jobs, browser errors) for development; \`docs_search\`, \`docs_read\` for this
  version's guides; \`check\` runs \`marmeon check\`. If its tools are not in your list, the server is not approved yet: use the commands below.`;

const BLOCK_HEAD = `${AGENTS_BEGIN}
Managed by \`marmeon agents:sync\` — edits inside this block are replaced; write yours outside.

Run \`marmeon\` through your package manager (\`pnpm exec marmeon\`, \`npx marmeon\`).
Pass \`--no-interaction\` to \`marmeon\` when you run it in a terminal.

`;
const BLOCK_DOCS = `## Documentation

- \`node_modules/marmeon/docs/\` holds the guides of the version you installed: \`marmeon docs\` lists them, \`marmeon docs <page>\`
  prints one. A \`docs/<page>.md\` in what \`marmeon\` prints is a file there.
- For a task — a resource, a public page or form, a background job — start with its
  recipe: \`marmeon docs\` lists them under "Recipes"; each names the generators, the files and the test.
- https://marmeon.com/docs is the newest version — read it to update; for your code, use the guides above.
  Add \`.md\` to a page's path for Markdown (https://marmeon.com/llms.txt is the index).`;
const BLOCK_REST = `## After a change

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
- Run \`marmeon\` from the app's root, never from inside \`node_modules\`.
- Your own stores (auth, sessions) extend the abstract base class (\`SignInStore\`, \`SessionStore\`, …), never a \`Database…\` class.
- An error carries \`[marmeon:XX]\`: look the code up with \`marmeon docs errors\` (section "Server error codes"). In development the last
  error is in \`.marmeon/last-error.md\`.`;
const INSTALL_POINT = `- \`marmeon agents:install\` adds the framework's skills and the MCP server \`marmeon mcp\` for your agent;
  \`marmeon agents:install --check\` says whether they are current.`;
const CHECK_POINT = '- `marmeon agents:install --check` says whether they are current.';

/**
 * What `marmeon agents:sync` keeps between the marks of an app's `AGENTS.md`, marks included, with `\n` line ends, for the skills
 * and the MCP entry `tools` says are installed. The text is built from constant lines picked by `tools`; no name read from the
 * disk is ever put into it, so a folder `marmeon-<any text>` cannot reach the instructions of an agent. Without an install it is
 * `AGENTS_BLOCK`. See docs/agents.md#skills-and-the-mcp-server.
 */
export function agentsBlock(tools: AgentTools): string {
  const known = tools.skillFolder === undefined ? [] : SKILL_USES.filter(([name]) => tools.skills.has(name));
  const skills = known.length > 0;
  if (!skills && !tools.mcp) return `${BLOCK_HEAD}${BLOCK_DOCS}\n${INSTALL_POINT}\n\n${BLOCK_REST}\n${AGENTS_END}`;
  const [title, intro] = HEADS[skills && tools.mcp ? 'both' : skills ? 'skills' : 'mcp'];
  const points: string[] = [];
  if (skills) {
    points.push(`- Load the skill for the task before you start (\`${tools.skillFolder}/<name>/SKILL.md\`):`);
    for (const [name, use] of known) points.push(`  - \`${name}\`: ${use}`);
  }
  if (tools.mcp) points.push(MCP_POINT);
  points.push(CHECK_POINT);
  return `${BLOCK_HEAD}${title}\n\n${intro}\n\n${points.join('\n')}\n\n${BLOCK_DOCS}\n\n${BLOCK_REST}\n${AGENTS_END}`;
}

/** The block of an app with nothing installed: what `agentsBlock(NO_TOOLS)` returns. */
export const AGENTS_BLOCK = agentsBlock(NO_TOOLS);
