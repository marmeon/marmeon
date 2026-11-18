import * as v from 'valibot';
import type { ChatJson } from './driver.ts';
import { ChatError } from './errors.ts';

type ChatJsonObject = { readonly [key: string]: ChatJson };

/** The format of Slack: Block Kit blocks as the incoming webhook takes them. Sent as written: it may mention on purpose. */
export type SlackRaw = {
  readonly blocks: readonly (ChatJsonObject & { readonly type: string })[];
};

/** A link button: the only component a webhook that no application owns may carry (no `custom_id`). */
export type DiscordLinkButton = { readonly type: 2; readonly style: 5; readonly label: string; readonly url: string };

/** An action row of 1 to 5 link buttons. */
export type DiscordActionRow = { readonly type: 1; readonly components: readonly DiscordLinkButton[] };

/**
 * The format of Discord: `content` (1 to 2000 characters), `embeds` (1 to 10) and `components` (1 to 5 action rows of 1 to 5 link
 * buttons: `{ type: 2, style: 5, label: 1 to 80 characters, url: an http(s) address of at most 512 characters }`, no `custom_id`: the
 * webhook is owned by no application) as the webhook takes them, at least one of the three, and who may be pinged: nobody unless
 * `allowedMentions` says so. `everyone: true` lets `@everyone` and `@here` ping, `users` or `roles` as `'all'` lets every user
 * or role mentioned in the text ping, as a list (at most 100 ids) only those. Anything else is refused with `ChatError`. See
 * `docs/chat-notifications.md#raw-formats`.
 */
export type DiscordRaw = {
  readonly content?: string;
  readonly embeds?: readonly ChatJsonObject[];
  readonly components?: readonly DiscordActionRow[];
  readonly allowedMentions?: {
    readonly everyone?: boolean;
    readonly users?: 'all' | readonly string[];
    readonly roles?: 'all' | readonly string[];
  };
};

/** The format of Teams: an Adaptive Card; the driver wraps it in the message envelope the Workflows trigger takes. */
export type TeamsRaw = {
  readonly card: ChatJsonObject & { readonly type: 'AdaptiveCard'; readonly version: string; readonly body: readonly ChatJsonObject[] };
};

const object = v.custom<ChatJsonObject>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'must be an object');

/** @internal */
export const slackRawSchema = v.strictObject({
  blocks: v.array(v.looseObject({ type: v.string() })),
});

const button = v.strictObject({
  type: v.literal(2),
  style: v.literal(5),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  url: v.pipe(
    v.string(),
    v.maxLength(512),
    v.check((url) => {
      try {
        return ['http:', 'https:'].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    }, 'must be an http or https address'),
  ),
});
const row = v.strictObject({ type: v.literal(1), components: v.pipe(v.array(button), v.minLength(1), v.maxLength(5)) });

const ids = v.union([v.literal('all'), v.pipe(v.array(v.string()), v.maxLength(100))]);

/** @internal */
export const discordRawSchema = v.pipe(
  v.strictObject({
    content: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2000))),
    embeds: v.optional(v.pipe(v.array(object), v.minLength(1), v.maxLength(10))),
    components: v.optional(v.pipe(v.array(row), v.minLength(1), v.maxLength(5))),
    allowedMentions: v.optional(v.strictObject({ everyone: v.optional(v.boolean()), users: v.optional(ids), roles: v.optional(ids) })),
  }),
  v.check((raw) => raw.content !== undefined || raw.embeds !== undefined || raw.components !== undefined, 'must hold content, embeds or components'),
);

/** @internal */
export const teamsRawSchema = v.strictObject({
  card: v.looseObject({ type: v.literal('AdaptiveCard'), version: v.string(), body: v.array(object) }),
});

/**
 * The raw format of `driver` when `raw` has one: checked against `schema`, `undefined` when there is none. A refusal names the
 * driver and the field, never a value; the key of a field the format does not know is data and stays out of it.
 * @internal
 */
export function parseRaw<const Schema extends v.GenericSchema>(driver: string, schema: Schema, raw: unknown): v.InferOutput<Schema> | undefined {
  if (raw === undefined) return undefined;
  const parsed = v.safeParse(schema, raw);
  if (parsed.success) return parsed.output;
  let issue: v.BaseIssue<unknown> = parsed.issues[0];
  const keys = (issue.path ?? []).map((item) => item.key);
  // a union of "all" and a list: say what is wrong inside the branch that got furthest, when one did
  while (issue.type === 'union' && issue.issues !== undefined) {
    const deepest = issue.issues.reduce((best, item) => ((item.path?.length ?? 0) > (best.path?.length ?? 0) ? item : best));
    if ((deepest.path?.length ?? 0) === 0) break;
    keys.push(...(deepest.path ?? []).map((item) => item.key));
    issue = deepest;
  }
  const unknown = issue.expected === 'never';
  if (unknown) keys.pop();
  let path = `raw.${driver}`;
  for (const key of keys) path += typeof key === 'number' ? `[${key}]` : `.${String(key)}`;
  throw new ChatError(`Chat message: "${path}" ${problem(issue, unknown)}.`);
}

/** What is wrong, from the schema's own words only: valibot's default text carries the received value, which is data. */
function problem(issue: v.BaseIssue<unknown>, unknown: boolean): string {
  // the messages of `custom` and `check` are ours
  if (issue.type === 'custom' || issue.type === 'check') return issue.message;
  if (unknown) return 'holds a field the format does not have';
  if (issue.received === 'undefined') return 'is required';
  if (issue.type === 'min_length') return `must have a length of at least ${String(issue.expected).slice(2)}`;
  if (issue.type === 'max_length') return `must have a length of at most ${String(issue.expected).slice(2)}`;
  const expected = (issue.expected ?? 'valid')
    .replace(/^\((.*)\)$/, '$1')
    .replaceAll(' | ', ' or ')
    .replace(/\bObject\b/g, 'an object')
    .replace(/\bArray\b/g, 'a list')
    .replace(/^(string|number|boolean)$/, 'a $1');
  return `must be ${expected}`;
}
