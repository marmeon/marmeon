/** What the landing's Agents section lists. A test compares it with the CLI's skills, tool list and messages. */
export const AGENT_SKILLS: readonly { name: string; text: string }[] = [
  { name: 'marmeon-debugging', text: 'Find out why the app fails before any code changes.' },
  { name: 'marmeon-feature-module', text: 'Add a feature as a module, with a policy and a test.' },
  { name: 'marmeon-migration', text: 'Change the schema and keep its types current.' },
  { name: 'marmeon-page', text: 'A page with a form that works without JavaScript, and an island that loads by itself.' },
  { name: 'marmeon-security-review', text: 'Review a change for security and report file and line.' },
  { name: 'marmeon-testing', text: 'Feature tests, fakes and a refused request for every route.' },
];

/** In the order of the CLI's tool list. */
export const AGENT_TOOLS: readonly { name: string; text: string }[] = [
  { name: 'routes', text: 'Every route with its middleware and who may call it.' },
  { name: 'last_error', text: 'The last 5xx error of the dev server.' },
  { name: 'docs_search', text: 'Search the docs of the installed version.' },
  { name: 'docs_read', text: 'Read a docs page or one section of it.' },
  { name: 'check', text: 'The report of marmeon check.' },
  { name: 'schema', text: 'Tables, columns and keys the migrations describe.' },
  { name: 'devtools_entries', text: 'Requests, queries, jobs and mails the devtools recorded.' },
  { name: 'migrations', text: 'Which migrations ran and which are pending.' },
  { name: 'database', text: 'Tables of a connection with their column and row counts.' },
  { name: 'app_overview', text: 'Modules, providers, events and schedules.' },
];

export const AGENTS_INSTALL_COMMAND = 'pnpm marmeon agents:install';

/** What `marmeon agents:install` prints in a new app, as the docs show it. */
export const AGENTS_INSTALL_OUTPUT: readonly string[] = [
  ...AGENT_SKILLS.map(({ name }) => `✓ Wrote .claude/skills/${name}/SKILL.md.`),
  '✓ Wrote .mcp.json.',
  '✓ Updated the block of AGENTS.md.',
  'Your agent asks you to approve the server marmeon the next time it starts.',
];
