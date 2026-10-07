// The engine under the rules: Valibot (E197) — inside this package only. Nothing here is public: no exported type names a
// Valibot type (an app's `.d.ts` would need `valibot` then — TS2742), so schemas leave this module as the opaque `Engine`.
import type { StandardIssue, StandardOptions, StandardResult } from '@marmeon/core';
import { messageOf, NOT_LIVE, translatable, type ValidationContext } from '@marmeon/router';
import * as v from 'valibot';
import { englishText, type TextKey } from './texts.ts';

/** A schema of the engine — opaque outside this module. */
export interface Engine {
  readonly '~engine': true;
}

/** What one validation builds its schema for. */
export interface BuildContext {
  /** The request's, when the router validates (`libraryOptions.marmeon`) — none for a config, a job or a schema on its own. */
  readonly request: ValidationContext | undefined;
  /** A live validation (E62): rules that are not live (`unique`, `exists`, async rules) do not run. */
  readonly live: boolean;
  /** `.live()` on this rule or one around it: its rules run in a live validation too. */
  readonly liveOptIn: boolean;
}

/** A message for the engine: called with the issue it describes (`translatable()` leaves its key there). */
export type Message = (issue: object) => string;

// What the engine's objects are, loosely — Valibot's own types stay out of every signature.
type Schema = any;
type Dataset = { value: unknown; typed?: boolean; issues?: any[] };

/** The `marmeon.validation.<key>` message of a rule, with its parameters — English without a translator. */
export function message(key: TextKey, params?: Readonly<Record<string, unknown>>): Message {
  return translatable(`marmeon.validation.${key}`, params, englishText(key));
}

/** A type check's message: "required" for a missing value (undefined, null, a form's empty field), else `key` ("must be a number"). */
export function typeMessage(key: TextKey): Message {
  const required = message('required');
  const wrong = message(key);
  return (issue) => {
    const { input } = issue as { input?: unknown };
    return input == null || input === '' ? required(issue) : wrong(issue);
  };
}

/**
 * A message a rule is given: a translation key the request's translator knows, a text — or a message function, what
 * `translatable(key, params, english)` of @marmeon/router makes (a key with parameters: `{min}`).
 */
export type RuleMessage = string | Message;

/** A message of the app: a translation key the request's translator knows, or a text — or a message function as it is. */
export function ownMessage(text: RuleMessage): Message {
  return typeof text === 'function' ? text : translatable(text, undefined, text);
}

/** `message`, and the issue says its rule is not live (E197) — a live validation drops it even if the rule ran. */
export function notLive(message: Message): Message {
  return (issue) => {
    Object.defineProperty(issue, NOT_LIVE, { value: true, configurable: true });
    return message(issue);
  };
}

/** How the rules validate: the first problem of a field only (Laravel's `bail` — what a form shows next to the field). */
const CONFIG = { abortPipeEarly: true } as const;

/**
 * One validation of a rule (its `~standard.validate`): builds the engine's schema for this call — with the request the router
 * hands over in `libraryOptions.marmeon` — and answers with plain Standard Schema issues: paths as keys, messages with the
 * field's name. Synchronous unless the rule has an async part (a `.unique()`, an async `.custom()`).
 */
export function validate(
  build: (context: BuildContext) => Engine,
  async: boolean,
  value: unknown,
  options: StandardOptions | undefined,
  attributes: 'humanized' | 'raw',
): StandardResult<unknown> | Promise<StandardResult<unknown>> {
  const request = requestOf(options);
  const schema: Schema = build({ request, live: request?.live === true, liveOptIn: false });
  if (async) return v.safeParseAsync(schema, value, CONFIG).then((result) => standardResult(result, attributes));
  return standardResult(v.safeParse(schema, value, CONFIG), attributes);
}

function requestOf(options: StandardOptions | undefined): ValidationContext | undefined {
  const marmeon = options?.libraryOptions?.marmeon;
  return typeof marmeon === 'object' && marmeon !== null && typeof (marmeon as ValidationContext).resolve === 'function' ? (marmeon as ValidationContext) : undefined;
}

function standardResult(result: { success: boolean; output: unknown; issues?: readonly any[] }, attributes: 'humanized' | 'raw'): StandardResult<unknown> {
  if (result.success) return { value: result.output };
  return { issues: (result.issues ?? []).map((issue) => standardIssue(issue, attributes)) };
}

/** A plain issue: `path` as keys (`['links', 0, 'url']`), what the rule left on it (its key, "not live"), the field named. */
function standardIssue(issue: any, attributes: 'humanized' | 'raw'): StandardIssue {
  const path: PropertyKey[] | undefined = issue.path?.map((item: { key: PropertyKey }) => item.key);
  const plain: { message: string; path?: PropertyKey[] } = path ? { message: issue.message, path } : { message: issue.message };
  for (const symbol of Object.getOwnPropertySymbols(issue)) Object.defineProperty(plain, symbol, { value: issue[symbol], configurable: true });
  const field = path?.map(String).join('.');
  // An environment variable keeps its name (APP_PORT); a form field reads as words (password_confirmation → "password confirmation").
  plain.message = messageOf(plain, attributes === 'raw' && field ? { labels: { attributes: { [field]: field } } } : {});
  return plain;
}

// ——— Types ———

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A number, or a string that spells one in decimal (what a form or a URL sends) — finite. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && NUMBER.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

const TRUE = new Set<unknown>([true, 1, '1', 'true', 'on', 'yes']);
const FALSE = new Set<unknown>([false, 0, '0', 'false', 'off', 'no']);

/** true/false, and what forms, URLs and `.env` files say for them (`1`, `on`, `yes` …). */
export function toBoolean(value: unknown): boolean | undefined {
  return TRUE.has(value) ? true : FALSE.has(value) ? false : undefined;
}

/** A type, and its transformation: `check` says whether the value is one, `convert` makes it the rule's output. */
export function typed(key: TextKey, check: (value: unknown) => boolean, convert?: (value: any) => unknown, describe: Message = typeMessage(key)): Engine {
  const base = v.custom(check, describe);
  return (convert ? v.pipe(base, v.transform(convert)) : base) as unknown as Engine;
}

/**
 * `engine`, run for a field an object does not get too (with `undefined`) — so its own message says what is missing, not the
 * object's "required" (`accepted`: an unticked checkbox sends nothing).
 */
export function runsWhenMissing(engine: Engine): Engine {
  return { ...(engine as Schema), type: 'optional', default: () => undefined } as unknown as Engine;
}

/**
 * A value of a type of the caller's own (`r.value()`): `check` answers what is wrong with it — a message — or nothing. It runs for a
 * missing value too (`undefined`), so the check says what missing means. The value is the output as it is.
 */
export function valueEngine(test: (value: unknown) => RuleMessage | undefined | void): Engine {
  return runsWhenMissing(
    v.pipe(
      v.unknown(),
      v.rawCheck(({ dataset, addIssue }) => {
        const answer = test(dataset.value);
        if (typeof (answer as { then?: unknown } | undefined)?.then === 'function') {
          throw new TypeError('An r.value() check returned a Promise — it is synchronous: check the value, or add an async .custom() after it.');
        }
        if (answer !== undefined) addIssue({ message: ownMessage(answer as RuleMessage) } as never);
      }),
    ) as unknown as Engine,
  );
}

/** A string — never one with a NUL character (Postgres refuses it: a 500 instead of a 422). */
export function stringEngine(): Engine {
  return typed('string', (value) => typeof value === 'string' && !value.includes('\0'));
}

export function arrayEngine(item: Engine, async: boolean): Engine {
  return (async ? v.arrayAsync(item as Schema, typeMessage('array')) : v.array(item as Schema, typeMessage('array'))) as unknown as Engine;
}

export function unionEngine(options: readonly Engine[], async: boolean): Engine {
  return (async ? v.unionAsync(options as Schema[], typeMessage('union')) : v.union(options as Schema[], typeMessage('union'))) as unknown as Engine;
}

/** A comma-separated list (`.env`: `ADMINS=a@x.io, b@x.io`) or a list — each item checked by `item`. */
export function listEngine(item: Engine, async: boolean): Engine {
  const split = (value: string | unknown[]) => (typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter((part) => part !== '') : value);
  const base = v.custom((value) => typeof value === 'string' || Array.isArray(value), typeMessage('array'));
  return (async ? v.pipeAsync(base, v.transform(split), arrayEngine(item, true) as Schema) : v.pipe(base, v.transform(split), arrayEngine(item, false) as Schema)) as unknown as Engine;
}

// ——— Objects ———

export interface ConditionalFields {
  readonly condition: (data: any) => boolean;
  readonly entries: Readonly<Record<string, Engine>>;
}

export interface Confirmation {
  readonly field: string;
  readonly confirmation: string;
}

/**
 * An object of fields: keys the shape does not name are left out. Conditional fields (`when`) are checked when their condition
 * holds for the object's other fields, confirmations (`confirmed`) once their field is valid — both alongside the other fields'
 * problems, not after them.
 */
export function objectEngine(entries: Readonly<Record<string, Engine>>, whens: readonly ConditionalFields[], confirmations: readonly Confirmation[], async: boolean): Engine {
  const base: Schema = async ? v.objectAsync(entries as Record<string, Schema>, typeMessage('object')) : v.object(entries as Record<string, Schema>, typeMessage('object'));
  if (whens.length === 0 && confirmations.length === 0) return base as unknown as Engine;
  return {
    ...base,
    '~run'(dataset: Dataset, config: unknown) {
      const input = dataset.value;
      const result = base['~run'](dataset, config);
      if (!async) return afterObject(result, input, whens, confirmations, config, false);
      return (async () => afterObject(await result, input, whens, confirmations, config, true))();
    },
  } as unknown as Engine;
}

function afterObject(dataset: Dataset, input: unknown, whens: readonly ConditionalFields[], confirmations: readonly Confirmation[], config: unknown, async: boolean): Dataset | Promise<Dataset> {
  if (typeof input !== 'object' || input === null) return dataset; // the type's issue is there already
  const fields = input as Record<string, unknown>;
  const output = dataset.value as Record<string, unknown>;
  const runs: { key: string; result: Dataset | Promise<Dataset> }[] = [];
  for (const { condition, entries } of whens) {
    let holds = false;
    try {
      holds = condition(output) === true;
    } catch {
      // A condition over a field that is not valid: it does not hold.
    }
    if (!holds) continue;
    for (const [key, schema] of Object.entries(entries)) runs.push({ key, result: (schema as Schema)['~run']({ value: fields[key] }, config) });
  }
  const finish = (results: { key: string; result: Dataset }[]): Dataset => {
    for (const { key, result } of results) {
      if (result.issues) {
        for (const issue of result.issues) {
          const item = { type: 'object', origin: 'value', input, key, value: fields[key] };
          if (issue.path) issue.path.unshift(item);
          else issue.path = [item];
          (dataset.issues ??= []).push(issue);
        }
        dataset.typed = false;
      } else if (result.value !== undefined) {
        output[key] = result.value;
      }
    }
    for (const { field, confirmation } of confirmations) {
      if (dataset.issues?.some((issue) => issue.path?.[0]?.key === field)) continue; // the field itself is not valid yet
      if (fields[confirmation] !== fields[field]) addIssue(dataset, input, confirmation, message('confirmed'));
    }
    return dataset;
  };
  if (!async) return finish(runs as { key: string; result: Dataset }[]);
  return Promise.all(runs.map(async ({ key, result }) => ({ key, result: await result }))).then(finish);
}

/** An issue of the object at `key` — what the engine's own issues look like. */
function addIssue(dataset: Dataset, input: unknown, key: string, describe: Message): void {
  const value = (input as Record<string, unknown>)[key];
  const issue: Record<string, unknown> = {
    kind: 'validation',
    type: 'confirmed',
    input: value,
    expected: null,
    received: typeof value,
    message: '',
    path: [{ type: 'object', origin: 'value', input, key, value }],
  };
  issue.message = describe(issue);
  dataset.typed = false;
  (dataset.issues ??= []).push(issue);
}

// ——— Modifiers ———

export interface Modifier {
  /** A missing value is fine — `undefined`, or the default when there is one (`default()` is optional too). */
  readonly optional: boolean;
  readonly nullable: boolean;
  /** `.default(value)`: what a missing value becomes (a copy of it, for an object or a list). */
  readonly fallback?: { readonly value: unknown } | undefined;
}

/**
 * `.optional()`, `.nullable()`, `.default()`: what a missing value is. An empty string — a form's empty field, `?q=`, `APP_PORT=` —
 * counts as missing (Laravel's ConvertEmptyStringsToNull): `null` where the rule is nullable and has no default, else undefined.
 */
export function modifiedEngine(inner: Engine, { optional, nullable, fallback }: Modifier, async: boolean): Engine {
  const schema = inner as Schema;
  return {
    kind: 'schema',
    // What an object asks of a field it does not get: an optional one may be left out (and a default is filled in).
    type: optional ? (nullable ? 'nullish' : 'optional') : 'nullable',
    reference: modifiedEngine,
    expects: schema.expects,
    async,
    default: fallback !== undefined ? () => undefined : undefined,
    '~run'(dataset: Dataset, config: unknown) {
      let value = dataset.value;
      if (value === '') value = nullable && fallback === undefined ? null : undefined;
      if (value === undefined && optional) {
        dataset.typed = true;
        dataset.value = fallback === undefined ? undefined : copy(fallback.value);
        return dataset;
      }
      if (value === null && nullable) {
        dataset.typed = true;
        dataset.value = null;
        return dataset;
      }
      dataset.value = value;
      return schema['~run'](dataset, config);
    },
  } as unknown as Engine;
}

function copy<T>(value: T): T {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

// ——— Steps ———

export function pipeEngine(base: Engine, items: readonly Engine[], async: boolean): Engine {
  if (items.length === 0) return base;
  return (async ? v.pipeAsync(base as Schema, ...(items as Schema[])) : v.pipe(base as Schema, ...(items as Schema[]))) as unknown as Engine;
}

export function check(test: (value: any) => boolean, describe: Message): Engine {
  return v.check(test, describe) as unknown as Engine;
}

export function checkAsync(test: (value: any) => Promise<boolean>, describe: Message): Engine {
  return v.checkAsync(test, describe) as unknown as Engine;
}

export function transform(convert: (value: any) => unknown, async: boolean): Engine {
  return (async ? v.transformAsync(async (value) => convert(value)) : v.transform(convert)) as unknown as Engine;
}

export const trim = (): Engine => v.trim() as unknown as Engine;
export const toLowerCase = (): Engine => v.toLowerCase() as unknown as Engine;
export const email = (): Engine => v.email(message('email')) as unknown as Engine;
export const uuid = (): Engine => v.uuid(message('uuid')) as unknown as Engine;
export const isoTimestamp = (): Engine => v.isoTimestamp(message('iso_timestamp')) as unknown as Engine;

/** A pattern the value must match — never a stateful one (`g`/`y` would make `test()` remember where it stopped). */
export function regex(pattern: RegExp, describe: Message): Engine {
  return v.regex(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')), describe) as unknown as Engine;
}

/** What a `.custom()` check answers: `false` — its message; a string — that message (a key or a text); else valid. */
export type CheckAnswer = boolean | string | void | undefined;

/**
 * `.custom()`: a check of the value that may name its own message; an async one awaits. `offline`: its issues say the rule is not
 * live (an async check without `.live()`).
 */
export function customCheck(test: (value: any) => CheckAnswer | Promise<CheckAnswer>, describe: Message, async: boolean, offline: boolean): Engine {
  const report = (answer: CheckAnswer, addIssue: (info: { message: Message }) => void) => {
    if (answer === false) addIssue({ message: offline ? notLive(describe) : describe });
    else if (typeof answer === 'string') addIssue({ message: offline ? notLive(ownMessage(answer)) : ownMessage(answer) });
  };
  if (async) return v.rawCheckAsync(async ({ dataset, addIssue }) => report(await test(dataset.value), addIssue as never)) as unknown as Engine;
  return v.rawCheck(({ dataset, addIssue }) => {
    const answer = test(dataset.value);
    if (typeof (answer as { then?: unknown } | undefined)?.then === 'function') {
      // Never skipped in silence (a Promise is no answer): an async check has to say so.
      throw new TypeError('A .custom() check returned a Promise — write it as an async function (async (value) => …), then the rule validates asynchronously.');
    }
    report(answer as CheckAnswer, addIssue as never);
  }) as unknown as Engine;
}
