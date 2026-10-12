export const DESCRIPTION_MAX = 160;
const SHORT = 110;

/**
 * A page's meta description from its first paragraph: as many whole sentences as fit into `max` characters. When that is under
 * 110 characters and more follows (or the first sentence alone is too long), the paragraph is cut at a word and ends in `…`.
 */
export function summarize(text: string, max = DESCRIPTION_MAX): string | undefined {
  // A paragraph that leads into a code block ends in a colon, which reads as unfinished on its own.
  return fit(text, max)?.replace(/:$/, '.');
}

function fit(text: string, max: number): string | undefined {
  const paragraph = text.replace(/\s+/g, ' ').trim();
  if (paragraph === '') return undefined;
  if (paragraph.length <= max) return paragraph;
  let sentences = '';
  for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9@])/)) {
    const joined = sentences === '' ? sentence : `${sentences} ${sentence}`;
    if (joined.length > max) break;
    sentences = joined;
  }
  if (sentences.length >= SHORT) return sentences;
  const room = paragraph.slice(0, max - 1);
  const cut = paragraph[max - 1] === ' ' ? room : room.slice(0, Math.max(room.lastIndexOf(' '), 0));
  return `${cut.replace(/[\s,;:]+$/, '')}…`;
}

/** What a page without a first paragraph says about itself. */
export function fallbackDescription(title: string, section: string): string {
  return `${title} — ${section}, in the Marmeon documentation.`;
}
