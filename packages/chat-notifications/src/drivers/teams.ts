import type { ChatContent, ChatField } from '../message.ts';
import type { ChatDriver, ChatJson } from '../driver.ts';
import { breakMaskedLinks } from '../escape.ts';
import { ChatError } from '../errors.ts';
import { parseRaw, teamsRawSchema } from '../raw.ts';
import { largest } from './fit.ts';

/** The message a Workflows flow takes: 28 KB. */
const MAX_BYTES = 28 * 1024;
const EMPTY_LINE = '\u200B';

/** A card is wrapped in the attachment envelope the "When a Teams webhook request is received" trigger takes. */
function envelope(card: ChatJson): ChatJson {
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
}

/** One `RichTextBlock`: its runs do not process Markdown, and `breakMaskedLinks` covers Teams clients that render it anyway. */
function block(...runs: { text: string; bold?: boolean; size?: string }[]): ChatJson {
  return {
    type: 'RichTextBlock',
    inlines: runs.map((run) => ({
      type: 'TextRun',
      text: breakMaskedLinks(run.text),
      ...(run.bold === true ? { weight: 'Bolder' } : {}),
      ...(run.size === undefined ? {} : { size: run.size }),
    })),
  };
}

const cut = (text: string, count: number): string => {
  const points = Array.from(text);
  return points.length <= count ? text : `${points.slice(0, Math.max(0, count - 1)).join('').trimEnd()}…`;
};

/** How much of the neutral message a card shows: the text cut to `textPoints` code points, the first `links` links, these field values. */
interface Shape {
  readonly textPoints: number;
  readonly links: number;
  readonly values: readonly string[];
}

function card(content: ChatContent, shape: Shape): ChatJson {
  const body: ChatJson[] = [];
  if (content.title !== undefined) body.push(block({ text: content.title, bold: true, size: 'Medium' }));
  if (shape.textPoints > 0) {
    for (const line of cut(content.text, shape.textPoints).split('\n')) body.push(block({ text: line.trim() === '' ? EMPTY_LINE : line }));
  }
  content.fields.forEach((field: ChatField, index) => {
    const value = shape.values[index] as string;
    body.push(value === '' ? block({ text: field.label, bold: true }) : block({ text: `${field.label}: `, bold: true }, { text: value }));
  });
  const actions = content.links.slice(0, shape.links).map((link) => ({ type: 'Action.OpenUrl', title: link.label, url: link.url }));
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
}

const size = (json: ChatJson): number => Buffer.byteLength(JSON.stringify(json));

/** The text is kept to at least this many code points before anything else goes. */
const TEXT_FLOOR = 200;

/**
 * The neutral message as an envelope within 28 KB, never refused. Each step is measured, and the first that fits is returned: the
 * whole message; the text cut down to `TEXT_FLOOR` code points; links dropped from the last; field values cut to `…` from the last;
 * the text cut below the floor, to one character and `…` at the least.
 */
function shorten(content: ChatContent): ChatJson {
  const full = Array.from(content.text).length;
  const values = content.fields.map((field) => field.value);
  const fits = (shape: Shape): boolean => size(envelope(card(content, shape))) <= MAX_BYTES;
  let shape: Shape = { textPoints: full, links: content.links.length, values };
  if (fits(shape)) return envelope(card(content, shape));

  const floor = Math.min(full, TEXT_FLOOR);
  const text = largest(floor, full, (count) => fits({ ...shape, textPoints: count }));
  if (text !== undefined) return envelope(card(content, { ...shape, textPoints: text }));
  shape = { ...shape, textPoints: floor };

  for (let links = content.links.length - 1; links >= 0; links -= 1) {
    shape = { ...shape, links };
    if (fits(shape)) return envelope(card(content, shape));
  }

  const shortened = [...values];
  for (let index = shortened.length - 1; index >= 0; index -= 1) {
    if (shortened[index] === '') continue;
    shortened[index] = '…';
    shape = { ...shape, values: [...shortened] };
    if (fits(shape)) return envelope(card(content, shape));
  }

  // the text below the floor: at least one character and the ellipsis (a text of one character is kept)
  const least = Math.min(floor, 2);
  const below = largest(least, floor, (count) => fits({ ...shape, textPoints: count })) ?? least;
  return envelope(card(content, { ...shape, textPoints: below }));
}

/**
 * Microsoft Teams through a Workflows webhook. The neutral message is `RichTextBlock`s of `TextRun`s (no `TextBlock`, no
 * `FactSet`: those process Markdown) with every `](` broken by a zero width space, and no `msteams.entities`, so `<at>` stays text.
 * A neutral message that would pass 28 KB is shortened (text to a floor, then links, field values and the rest of the text), never refused; a raw card that is too large throws `ChatError`.
 * @internal
 */
export const teams = Object.freeze({
  hosts: Object.freeze(['*.environment.api.powerplatform.com']),
  paths: Object.freeze(['/powerautomate/automations/direct/']),
  render(content, raw) {
    const format = parseRaw('teams', teamsRawSchema, raw);
    if (format !== undefined) {
      const json = envelope(format.card as ChatJson);
      if (size(json) > MAX_BYTES) throw new ChatError('Chat message: "raw.teams.card" is larger than the 28 KB Teams accepts.');
      return { json };
    }
    return { json: shorten(content) };
  },
} satisfies ChatDriver);
