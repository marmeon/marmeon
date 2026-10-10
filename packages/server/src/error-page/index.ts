/**
 * The development error page — loaded by the kernel with `import()` only when it is in debug mode
 * (`ServerConfig.debug`, `NODE_ENV=development`): a production server never loads this code.
 */
import { ERROR_PAGE_CSP, renderErrorPage } from './html.ts';
import { buildReport, type ReportInput } from './report.ts';

export { reportMarkdown } from './markdown.ts';
export { ERROR_PAGE_CSP, renderErrorPage } from './html.ts';
export { buildReport, editorLink, parseStack, withSnippets } from './report.ts';
export type { ErrorReport, ReportInput, StackFrame } from './report.ts';
export { codeFrame, overlayError, overlayScript } from './overlay.ts';
export { createRequestRecorder } from './recorder.ts';
export type { OverlayError } from './overlay.ts';

/** The error page as the response to a page request — never cached, never indexed. */
export async function errorPageResponse(input: ReportInput, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
  const html = renderErrorPage(await buildReport(input));
  return new Response(html, {
    status: input.status,
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-security-policy': ERROR_PAGE_CSP },
  });
}
