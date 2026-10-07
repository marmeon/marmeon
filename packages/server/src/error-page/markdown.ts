import type { ErrorReport } from './report.ts';

/**
 * The report as Markdown — what "Copy as Markdown" copies, for an issue or a chat. Built from the same redacted report as
 * the page (E125); no source code, only where the frames are.
 */
export function reportMarkdown(report: ErrorReport): string {
  const out: string[] = [`# ${report.error.name}: ${oneLine(report.error.message)}`, ''];
  for (const cause of report.causes) out.push(`Caused by ${cause.name}: ${oneLine(cause.message)}`, '');
  out.push(
    `- **Status:** ${report.status}`,
    `- **Request:** ${report.request.method} ${report.request.url}${report.requestId ? ` (request id \`${report.requestId}\`)` : ''}`,
  );
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
      out.push(`- **${solution.title}** — ${solution.text}${solution.command ? ` Command: \`${solution.command}\`` : ''}${solution.docs ? ` (docs: ${solution.docs})` : ''}`);
    }
    out.push('');
  }

  out.push('## Stack', '');
  report.frames.forEach((frame, index) => {
    out.push(`${index + 1}. ${frame.fn ? `\`${frame.fn}\` ` : ''}${frame.display}:${frame.line}:${frame.column}${frame.app ? ' (app)' : ''}`);
  });
  if (report.frames.length === 0) out.push('(no stack)');
  out.push('');

  if (report.queries.length > 0) {
    out.push(`## Queries (${report.queries.length + report.droppedQueries})`, '');
    report.queries.forEach((query, index) => {
      out.push(`${index + 1}. \`${oneLine(query.sql)}\`${query.parameters.length > 0 ? ` — ${JSON.stringify(query.parameters)}` : ''} (${round(query.durationMs)} ms${query.connection === 'default' ? '' : `, ${query.connection}`})`);
    });
    if (report.droppedQueries > 0) out.push(`… and ${report.droppedQueries} more`);
    out.push('');
  }

  if (report.logs.length > 0) {
    out.push('## Log', '');
    for (const entry of report.logs) out.push(`- ${entry.level}: ${oneLine(entry.message)}${isEmpty(entry.context) ? '' : ` ${JSON.stringify(entry.context)}`}`);
    if (report.droppedLogs > 0) out.push(`- … and ${report.droppedLogs} more`);
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

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);
}
