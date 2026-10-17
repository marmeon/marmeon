import type { ErrorReport } from './report.ts';

/**
 * The report as Markdown — what "Copy as Markdown" copies, for an issue or a chat. Built from the same redacted report as
 * the page; no source code, only where the frames are. `fenced`: the message and causes in a code fence, as data and not as
 * Markdown of the document — for a file an agent reads.
 */
export function reportMarkdown(report: ErrorReport, { fenced = false }: { fenced?: boolean } = {}): string {
  const out: string[] = fenced ? ['# Error report', '', ...fence([`${report.error.name}: ${report.error.message}`, ...report.causes.map((cause) => `Caused by ${cause.name}: ${cause.message}`)]), ''] : [`# ${report.error.name}: ${oneLine(report.error.message)}`, ''];
  if (!fenced) for (const cause of report.causes) out.push(`Caused by ${cause.name}: ${oneLine(cause.message)}`, '');
  out.push(
    `- **Status:** ${report.status}`,
    ...(report.code ? [`- **Code:** ${report.code}`] : []),
  );
  const requestLine = `${report.request.method} ${report.request.url}${report.requestId ? ` (request id \`${report.requestId}\`)` : ''}`;
  if (fenced) out.push('- **Request:**', ...fence([requestLine]));
  else out.push(`- **Request:** ${requestLine}`);
  if (report.route) {
    const { name, path, controller, middleware } = report.route;
    out.push(`- **Route:** ${name ? `\`${name}\` ` : ''}\`${path}\`${controller ? ` → \`${controller}\`` : ''}${middleware.length > 0 ? ` (middleware: ${middleware.join(', ')})` : ''}`);
  }
  const { node, nodeEnv, platform, app, packages } = report.environment;
  out.push(
    `- **Environment:** Node ${node}, NODE_ENV=${nodeEnv ?? '(unset)'}, ${platform}${app ? `, app ${app}` : ''}`,
    `- **Marmeon:** ${packages.map((entry) => `${entry.name}${entry.version ? `@${entry.version}` : ''}`).join(', ') || '(no packages discovered)'}`,
    '',
  );

  if (report.solutions.length > 0) {
    out.push('## Solutions', '');
    for (const solution of report.solutions) {
      out.push(`- **${solution.title}**${solution.code ? ` (${solution.code})` : ''} — ${solution.text}${solution.command ? ` Command: \`${solution.command}\`` : ''}${solution.docs ? ` (docs: ${solution.docs})` : ''}`);
    }
    out.push('');
  }

  out.push('## Stack', '');
  const frames = report.frames.map((frame, index) => `${index + 1}. ${frame.fn ? `\`${frame.fn}\` ` : ''}${frame.display}:${frame.line}:${frame.column}${frame.app ? ' (app)' : ''}`);
  if (frames.length === 0) frames.push('(no stack)');
  out.push(...(fenced ? fence(frames) : frames));
  out.push('');

  if (report.queries.length > 0) {
    out.push(`## Queries (${report.queries.length + report.droppedQueries})`, '');
    const queries: string[] = [];
    report.queries.forEach((query, index) => {
      queries.push(`${index + 1}. \`${oneLine(query.sql)}\`${query.parameters.length > 0 ? ` — ${JSON.stringify(query.parameters)}` : ''} (${round(query.durationMs)} ms${query.connection === 'default' ? '' : `, ${query.connection}`})`);
    });
    if (report.droppedQueries > 0) queries.push(`… and ${report.droppedQueries} more`);
    out.push(...(fenced ? fence(queries) : queries));
    out.push('');
  }

  if (report.logs.length > 0) {
    out.push('## Log', '');
    const logs: string[] = [];
    for (const entry of report.logs) logs.push(`- ${entry.level}: ${oneLine(entry.message)}${isEmpty(entry.context) ? '' : ` ${JSON.stringify(entry.context)}`}`);
    if (report.droppedLogs > 0) logs.push(`- … and ${report.droppedLogs} more`);
    out.push(...(fenced ? fence(logs) : logs));
    out.push('');
  }

  if (report.warnings.length > 0) {
    out.push('## Injection warnings', '');
    for (const warning of report.warnings) out.push(`- ${warning}`);
    out.push('');
  }

  out.push('## Request', '', '```json', JSON.stringify({ headers: report.request.headers, query: report.request.query, body: report.request.body }, null, 2), '```', '');
  return out.join('\n');
}

/** Lines in a code fence one backtick longer than the longest run of backticks inside them, so the text cannot close it. */
function fence(lines: readonly string[]): string[] {
  const longest = Math.max(0, ...lines.flatMap((line) => [...line.matchAll(/`+/g)].map((run) => run[0].length)));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return [ticks, ...lines, ticks];
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);
}
