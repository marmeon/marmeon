import type { ChatDriver, ChatJson } from '../driver.ts';
import { escapeSlackText } from '../escape.ts';
import { parseRaw, slackRawSchema } from '../raw.ts';
import { fitEscaped, plain } from './fit.ts';

// Slack's limits, in characters; counted here in UTF-16 units, the stricter reading (its documentation does not say which it is).
const LIMITS = { fallback: 4000, header: 150, section: 3000, field: 2000, button: 75 } as const;

const text = (value: string): ChatJson => ({ type: 'plain_text', text: value });

/**
 * Slack's incoming webhook. The neutral message goes into `plain_text` objects, which Slack does not parse; only the fallback
 * `text` is `mrkdwn`, and it is escaped (`<!channel>`, `<@U1>` and `<url|label>` stay text). No `mrkdwn` object, no `link_names`,
 * no unfurling. Every text is cut after escaping to its limit, so a message never fails because of its length.
 * @internal
 */
export const slack = Object.freeze({
  hosts: Object.freeze(['hooks.slack.com']),
  paths: Object.freeze(['/services/']),
  render(content, raw) {
    const format = parseRaw('slack', slackRawSchema, raw);
    const fallback = fitEscaped(content.title === undefined ? content.text : `${content.title}\n${content.text}`, escapeSlackText, LIMITS.fallback);
    const blocks: ChatJson[] = [];
    if (format !== undefined) {
      blocks.push(...(format.blocks as ChatJson[]));
    } else {
      if (content.title !== undefined) blocks.push({ type: 'header', text: text(fitEscaped(content.title, plain, LIMITS.header)) });
      blocks.push({ type: 'section', text: text(fitEscaped(content.text, plain, LIMITS.section)) });
      if (content.fields.length > 0) {
        const fields = content.fields.map((field) => text(fitEscaped(field.value === '' ? field.label : `${field.label}\n${field.value}`, plain, LIMITS.field)));
        blocks.push({ type: 'section', fields });
      }
      if (content.links.length > 0) {
        const elements = content.links.map((link) => ({ type: 'button', text: text(fitEscaped(link.label, plain, LIMITS.button)), url: link.url }));
        blocks.push({ type: 'actions', elements });
      }
    }
    return { json: { text: fallback, unfurl_links: false, unfurl_media: false, blocks } };
  },
} satisfies ChatDriver);
