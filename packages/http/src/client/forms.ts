import type { PageObject } from '../page.ts';

/**
 * The first validation message per field of a page — the server sends a list per field (the shared `errors` prop,
 * after it redirected back to the form); forms show the first. Empty when the page has none.
 */
export function firstErrors(page: PageObject): Record<string, string> {
  const errors = (page.props as { errors?: unknown }).errors;
  if (typeof errors !== 'object' || errors === null) return {};
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (typeof first === 'string') result[field] = first;
  }
  return result;
}
