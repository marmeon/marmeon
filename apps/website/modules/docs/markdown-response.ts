import { textResponse } from '../site/text-response.ts';

/** A page's Markdown (`text/markdown`) with the HTML page named as the canonical one, so search engines rank that, not this copy. */
export function markdownResponse(body: string, canonicalUrl: string, headers: Record<string, string> = {}): Response {
  return textResponse(body, 'text/markdown; charset=utf-8', { ...headers, link: `<${canonicalUrl}>; rel="canonical"` });
}
