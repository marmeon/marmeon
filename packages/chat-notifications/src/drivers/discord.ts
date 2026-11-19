import type { ChatDriver, ChatJson } from '../driver.ts';
import { escapeDiscordMarkdown } from '../escape.ts';
import { discordRawSchema, parseRaw } from '../raw.ts';
import { fitEscaped, plain } from './fit.ts';

// Discord's limits, in characters; counted here in UTF-16 units, the stricter reading.
const LIMITS = { title: 256, description: 4096, name: 256, value: 1024, embed: 6000, label: 80, url: 512 } as const;

/** The description keeps this many escaped units before any field value is cut. */
const DESCRIPTION_FLOOR = 200;

/** A field value must not be empty: a zero width space keeps the field in its place. */
const EMPTY = '\u200B';
/** What stands where an address does not fit. */
const CUT = '…';

/** An address that is safe between angle brackets: Discord shows `<href>` as a link without a preview. */
const BRACKETABLE = /^[^<>\s]+$/;

/** One field of the embed: its name and the source of its value; an address is shown whole or as `…`, never escaped or cut. */
interface Shown {
  readonly name: string;
  readonly source: string;
  readonly address: boolean;
}

/** `<href>` when it fits a field value and has nothing that would end the brackets, `…` otherwise. */
function addressValue(href: string): string {
  return href.length + 2 <= LIMITS.value && BRACKETABLE.test(href) ? `<${href}>` : CUT;
}

/** Who may be pinged by a raw message: nobody unless it names them. */
function allowedMentions(raw: { everyone?: boolean; users?: 'all' | string[]; roles?: 'all' | string[] } | undefined): ChatJson {
  const parse: string[] = [];
  if (raw?.everyone === true) parse.push('everyone');
  if (raw?.users === 'all') parse.push('users');
  if (raw?.roles === 'all') parse.push('roles');
  return {
    parse,
    ...(Array.isArray(raw?.users) ? { users: raw.users } : {}),
    ...(Array.isArray(raw?.roles) ? { roles: raw.roles } : {}),
  };
}

/**
 * Discord's webhook. The neutral message is one embed with every text escaped (`<@123>`, `[x](url)`, `**b**`, `# h`, an
 * address and `@everyone` stay text) and `allowed_mentions.parse` empty, so nothing pings. Every text is cut after escaping to
 * its limit, then the embed as a whole to 6000 characters (description down to a floor of 200 units, then field values from the last, then the rest of the description), so a message
 * never fails because of its length. A link whose address is longer than a button takes (512 characters) is shown as a field
 * with the address in angle brackets, whole or `…` when it does not fit.
 * @internal
 */
export const discord = Object.freeze({
  hosts: Object.freeze(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']),
  paths: Object.freeze(['/api/webhooks/', '/api/v10/webhooks/']),
  render(content, raw) {
    const format = parseRaw('discord', discordRawSchema, raw);
    if (format !== undefined) {
      const json: Record<string, ChatJson> = { allowed_mentions: allowedMentions(format.allowedMentions) };
      if (format.content !== undefined) json.content = format.content;
      if (format.embeds !== undefined) json.embeds = format.embeds as ChatJson[];
      if (format.components !== undefined) json.components = format.components as ChatJson[];
      return format.components === undefined ? { json } : { json, search: { with_components: 'true' } };
    }

    const buttons = content.links.filter((link) => link.url.length <= LIMITS.url);
    const shown: Shown[] = [
      ...content.fields.map((field) => ({ name: field.label, source: field.value, address: false })),
      ...content.links.filter((link) => link.url.length > LIMITS.url).map((link) => ({ name: link.label, source: link.url, address: true })),
    ];

    const title = content.title === undefined ? '' : fitEscaped(content.title, escapeDiscordMarkdown, LIMITS.title);
    let description = fitEscaped(content.text, escapeDiscordMarkdown, LIMITS.description);
    const fieldNames = shown.map((field) => fitEscaped(field.name, escapeDiscordMarkdown, LIMITS.name));
    const values = shown.map((field) => (field.address ? addressValue(field.source) : fitEscaped(field.source, escapeDiscordMarkdown, LIMITS.value) || EMPTY));

    // the embed as a whole: the description down to its floor, then field values from the last
    const total = (): number => title.length + description.length + fieldNames.reduce((sum, name) => sum + name.length, 0) + values.reduce((sum, value) => sum + value.length, 0);
    let over = total() - LIMITS.embed;
    if (over > 0) {
      description = fitEscaped(content.text, escapeDiscordMarkdown, Math.max(Math.min(DESCRIPTION_FLOOR, description.length), description.length - over));
      over = total() - LIMITS.embed;
    }
    for (let index = values.length - 1; index >= 0 && over > 0; index -= 1) {
      const field = shown[index] as Shown;
      const current = values[index] as string;
      values[index] = field.address ? CUT : fitEscaped(field.source, escapeDiscordMarkdown, Math.max(1, current.length - over)) || EMPTY;
      over = total() - LIMITS.embed;
    }
    // only now the description below its floor: one character and the ellipsis at the least
    if (over > 0) description = fitEscaped(content.text, escapeDiscordMarkdown, Math.max(2, description.length - over));

    const embed: Record<string, ChatJson> = {};
    if (title !== '') embed.title = title;
    if (description !== '') embed.description = description;
    if (fieldNames.length > 0) embed.fields = fieldNames.map((name, index) => ({ name, value: values[index] as string, inline: false }));
    const json: Record<string, ChatJson> = { allowed_mentions: { parse: [] }, embeds: [embed] };
    if (buttons.length === 0) return { json };
    json.components = [
      { type: 1, components: buttons.map((link) => ({ type: 2, style: 5, label: fitEscaped(link.label, plain, LIMITS.label), url: link.url })) },
    ];
    return { json, search: { with_components: 'true' } };
  },
} satisfies ChatDriver);
