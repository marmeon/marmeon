import * as v from 'valibot';
import { NAME } from './destination.ts';
import type { ChatJson } from './driver.ts';
import { ChatError } from './errors.ts';

/** Where a message goes: a named destination (`'ops'`: lower case letters, digits and hyphens) or a webhook address of its own, as a plain object, with the driver that formats for it. */
export type ChatDestination = string | { readonly url: string; readonly driver?: string };

/** A label and a value shown as a pair. The label is cut at 50 characters and must not be empty, the value is cut at 300. */
export interface ChatField {
  readonly label: string;
  readonly value: string;
}

/** A labelled link: an `http` or `https` address without credentials, at most 2000 characters; the label is cut at 75. */
export interface ChatLink {
  readonly label: string;
  readonly url: string;
}

/** Raw formats by driver name; a driver package merges its own, as a type alias built from `ChatJson`. */
export interface ChatRawFormats {}

/**
 * The `raw` of a message: the format of one driver per key. Without a declared format nothing is accepted. A format that is no
 * JSON turns into an object type that names the rule.
 */
export type ChatRaw<Formats = ChatRawFormats> = [keyof Formats] extends [never]
  ? never
  : {
      readonly [K in keyof Formats]?: Formats[K] extends ChatJson
        ? Formats[K]
        : { readonly 'A raw format is JSON: declare it as a type alias built from ChatJson (no interface, unknown, Date or Map)': Formats[K] };
    };

/**
 * A chat message: plain text, shown the same way by every driver. Lengths are counted in code points and cut with `…`: title
 * 150, text 2000, field label 50, field value 300, link label 75.
 */
export interface ChatMessage {
  readonly to: ChatDestination;
  /** Plain text on one line; cut at 150 characters. */
  readonly title?: string;
  /** Plain text, required. Cut at 2000 characters. */
  readonly text: string;
  /** At most 10; more throws `ChatError`. */
  readonly fields?: readonly ChatField[];
  /** At most 5; more throws `ChatError`. */
  readonly links?: readonly ChatLink[];
  /** The format of one driver, used instead of the neutral rendering when that driver sends. At most 10 000 values and 64 KB as JSON. */
  readonly raw?: ChatRaw;
}

/** A message as drivers get it and the queue keeps it: normalized, without `to`. */
export interface ChatContent {
  readonly title?: string;
  readonly text: string;
  readonly fields: readonly ChatField[];
  readonly links: readonly ChatLink[];
  readonly raw?: Readonly<Record<string, ChatJson>>;
}

const CAPS = { title: 150, text: 2000, label: 50, value: 300, linkLabel: 75 } as const;
const MAX_FIELDS = 10;
const MAX_LINKS = 5;
const MAX_URL = 2000;
const MAX_RAW_DEPTH = 64;
const MAX_RAW_NODES = 10_000;
const MAX_RAW_BYTES = 64 * 1024;

const shape = v.object({
  to: v.unknown(),
  title: v.optional(v.string()),
  text: v.string(),
  fields: v.optional(v.array(v.object({ label: v.string(), value: v.string() }))),
  links: v.optional(v.array(v.object({ label: v.string(), url: v.string() }))),
  raw: v.optional(v.unknown()),
});

function fail(what: string): never {
  throw new ChatError(`Chat message: ${what}`);
}

function pathOf(issue: v.BaseIssue<unknown>): string {
  let path = '';
  for (const item of issue.path ?? []) {
    path += typeof item.key === 'number' ? `[${item.key}]` : `${path === '' ? '' : '.'}${String(item.key)}`;
  }
  return path === '' ? 'the message' : path;
}

/** Bidirectional control characters and control characters other than newline and tab are removed. */
const STRIPPED = /[\p{Cc}\p{Bidi_Control}]/gu;

function clean(text: string): string {
  return text.toWellFormed().replace(/\r\n?/g, '\n').replace(STRIPPED, (char) => (char === '\n' || char === '\t' ? char : ''));
}

function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, ' ').trim();
}

/** At most `cap` code points, ending in `…` when cut; a surrogate pair is never split. */
function truncate(text: string, cap: number): string {
  const points = Array.from(text);
  return points.length <= cap ? text : `${points.slice(0, cap - 1).join('').trimEnd()}…`;
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function destination(to: unknown): ChatMessage['to'] {
  if (typeof to === 'string') {
    if (!NAME.test(to)) fail('"to" must be a destination name (lower case letters, digits and hyphens) or a plain object { url, driver? }.');
    return to;
  }
  if (typeof to !== 'object' || to === null || Array.isArray(to) || !isPlain(to)) fail('"to" must be a destination name or a plain object { url, driver? }.');
  const { url, driver } = to as { url?: unknown; driver?: unknown };
  if (typeof url !== 'string' || url === '' || url.length > MAX_URL) fail(`"to.url" must be a string of 1 to ${MAX_URL} characters.`);
  if (driver === undefined) return Object.freeze({ url });
  if (typeof driver !== 'string' || !NAME.test(driver)) fail('"to.driver" must be a driver name (lower case letters, digits and hyphens).');
  return Object.freeze({ url, driver });
}

function link(input: { label: string; url: string }, index: number): ChatLink {
  const label = truncate(oneLine(input.label), CAPS.linkLabel);
  if (label === '') fail(`"links[${index}].label" must not be empty.`);
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail(`"links[${index}].url" is not an address.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`"links[${index}].url" must use http or https.`);
  if (parsed.username !== '' || parsed.password !== '') fail(`"links[${index}].url" must not carry credentials.`);
  if (input.url.length > MAX_URL || parsed.href.length > MAX_URL) fail(`"links[${index}].url" must not be longer than ${MAX_URL} characters.`);
  return Object.freeze({ label, url: parsed.href });
}

interface Budget {
  nodes: number;
  /** The size `raw` has as JSON, counted while it is walked. */
  bytes: number;
}

function spend(budget: Budget, nodes: number, bytes: number): void {
  budget.nodes += nodes;
  budget.bytes += bytes;
  if (budget.nodes > MAX_RAW_NODES) fail(`"raw" holds more than ${MAX_RAW_NODES} values.`);
  if (budget.bytes > MAX_RAW_BYTES) fail(`"raw" is larger than ${MAX_RAW_BYTES / 1024} KB as JSON.`);
}

/** The UTF-8 size of a string in its JSON form: quotes and escapes included. */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

/**
 * A frozen deep copy of `value` when it is JSON, counted while it is walked (a value that several parents share counts once per
 * parent): values, and the bytes of the JSON the copy serializes to. A refusal names `raw`, never a key or a value: both are data.
 */
function json(value: unknown, depth: number, budget: Budget): ChatJson {
  spend(budget, 1, 0);
  if (typeof value === 'string') {
    const text = value.toWellFormed();
    spend(budget, 0, jsonBytes(text));
    return text;
  }
  if (value === null || typeof value === 'boolean') {
    spend(budget, 0, String(value).length);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('"raw" holds a number that is not finite.');
    spend(budget, 0, String(value).length);
    return value;
  }
  if (typeof value !== 'object') return fail(`"raw" holds a value that is not JSON (${typeof value}).`);
  if (depth >= MAX_RAW_DEPTH) return fail(`"raw" is nested deeper than ${MAX_RAW_DEPTH} levels.`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return fail('"raw" holds an array that is not a plain one.');
    spend(budget, 0, 2);
    const items: ChatJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) spend(budget, 0, 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      items.push(json(descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined, depth + 1, budget));
    }
    return Object.freeze(items);
  }
  if (!isPlain(value) || Object.getOwnPropertySymbols(value).length > 0) return fail('"raw" holds an object that is not a plain one.');
  spend(budget, 0, 2);
  const entries = new Map<string, ChatJson>();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return fail('"raw" holds a getter.');
    const name = key.toWellFormed();
    if (entries.has(name)) return fail('"raw" holds two keys that are the same once normalized.');
    // the key, its colon, and the comma before it
    spend(budget, 0, jsonBytes(name) + 1 + (entries.size > 0 ? 1 : 0));
    entries.set(name, json(descriptor.value as unknown, depth + 1, budget));
  }
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Checks a message and returns its destination and its content: bidirectional control characters and control characters other
 * than newline and tab are removed, lone surrogates replaced, texts cut to the caps, `raw` a frozen JSON copy. A shape that is wrong throws `ChatError` naming the field, never its value;
 * a text that is too long is cut.
 * @internal
 */
export function normalizeMessage(input: unknown): { readonly to: ChatDestination; readonly content: ChatContent } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('the message must be an object.');
  const parsed = v.safeParse(shape, input);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    return fail(`"${pathOf(issue)}" ${issue.received === 'undefined' ? 'is required' : `must be ${issue.expected ?? 'valid'}`}.`);
  }
  const message = parsed.output;
  const to = destination(message.to);
  const text = truncate(clean(message.text).trim(), CAPS.text);
  if (text === '') fail('"text" must not be empty.');
  const title = message.title === undefined ? '' : truncate(oneLine(message.title), CAPS.title);
  const fields = message.fields ?? [];
  if (fields.length > MAX_FIELDS) fail(`"fields" holds more than ${MAX_FIELDS} entries.`);
  const links = message.links ?? [];
  if (links.length > MAX_LINKS) fail(`"links" holds more than ${MAX_LINKS} entries.`);

  const content: { title?: string; text: string; fields: readonly ChatField[]; links: readonly ChatLink[]; raw?: Readonly<Record<string, ChatJson>> } = {
    text,
    fields: Object.freeze(
      fields.map((field, index) => {
        const label = truncate(oneLine(field.label), CAPS.label);
        if (label === '') fail(`"fields[${index}].label" must not be empty.`);
        return Object.freeze({ label, value: truncate(clean(field.value).trim(), CAPS.value) });
      }),
    ),
    links: Object.freeze(links.map(link)),
  };
  if (title !== '') content.title = title;
  if (message.raw !== undefined) {
    if (typeof message.raw !== 'object' || message.raw === null || Array.isArray(message.raw)) fail('"raw" must be a plain object.');
    content.raw = json(message.raw, 0, { nodes: 0, bytes: 0 }) as Readonly<Record<string, ChatJson>>;
  }
  return Object.freeze({ to, content: Object.freeze(content) });
}
