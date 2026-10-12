import { PAGE_HEADER } from '@marmeon/http/page';

const MAX_RANGES = 64;
const WEIGHT = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

type Range = { type: string; subtype: string; q: number };

/** The media ranges of an `Accept` header; a range with an unreadable weight is dropped, and only the first 64 count. */
function accepted(header: string): Range[] {
  const ranges: Range[] = [];
  for (const item of header.split(',', MAX_RANGES)) {
    const [media = '', ...parameters] = item.split(';');
    const [type = '', subtype = '', ...rest] = media.trim().toLowerCase().split('/');
    if (!type || !subtype || rest.length > 0) continue;
    let q = 1;
    let valid = true;
    for (const parameter of parameters) {
      const [name = '', value = ''] = parameter.split('=', 2);
      if (name.trim().toLowerCase() !== 'q') continue;
      if (WEIGHT.test(value.trim())) q = Number(value.trim());
      else valid = false;
    }
    if (valid) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/** The weight the most specific matching range gives a type (RFC 9110 §12.5.1): an exact type over `a/*` over any type; 0 when none matches. */
function qualityOf(ranges: readonly Range[], type: string, subtype: string): number {
  let best = -1;
  let q = 0;
  for (const range of ranges) {
    const specificity = range.type === type && range.subtype === subtype ? 3 : range.type === type && range.subtype === '*' ? 2 : range.type === '*' && range.subtype === '*' ? 1 : 0;
    if (specificity === 0) continue;
    if (specificity > best || (specificity === best && range.q > q)) {
      best = specificity;
      q = range.q;
    }
  }
  return q;
}

/**
 * Whether the client asks for Markdown rather than HTML: `text/markdown` is named in `Accept` (not only through `text/*` or a
 * wildcard for every type) and weighs at least as much as `text/html`. Browsers never name `text/markdown`, so they always get HTML; Visits,
 * partial reloads and layers (`x-marmeon`) always want the page object.
 */
export function prefersMarkdown(request: Request): boolean {
  if (request.headers.has(PAGE_HEADER)) return false;
  const ranges = accepted(request.headers.get('accept') ?? '');
  const markdown = ranges.some((range) => range.type === 'text' && range.subtype === 'markdown' && range.q > 0);
  return markdown && qualityOf(ranges, 'text', 'markdown') >= qualityOf(ranges, 'text', 'html');
}
