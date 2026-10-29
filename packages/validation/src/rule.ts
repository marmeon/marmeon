import type { InferInput, InferOutput, StandardSchemaV1 } from '@marmeon/core';
import type { ValidationContext } from '@marmeon/router';
import * as engine from './engine.ts';
import type { BuildContext, CheckAnswer, ConditionalFields, Confirmation, Engine, RuleMessage } from './engine.ts';
import type { TextKey } from './texts.ts';

/** One part of a rule's pipe — built per validation (it may depend on the request), or left out (`undefined`). */
export interface RuleStep {
  readonly build: (context: BuildContext) => Engine | undefined;
  /** It awaits something (the database): the rule validates asynchronously. */
  readonly async: boolean;
  /** It depends on the validation's request or on whether it is live: never built once for all. */
  readonly contextual: boolean;
}

/** How a rule is built (internal — the shape of a rule, not its API). */
export interface RuleDefinition {
  readonly base: (context: BuildContext, sizes: readonly engine.SizeGate[]) => Engine;
  readonly steps: readonly RuleStep[];
  /** A list's size rules: checked before its items, so the base (the list engine) takes them along. */
  readonly sizes: readonly engine.SizeGate[];
  readonly async: boolean;
  readonly contextual: boolean;
  /** `.live()`: its rules run in a live validation too. */
  readonly live: boolean;
  /** An object, a list or a union: its rules are other rules — `.live()` belongs on them, never on it. */
  readonly container: boolean;
  /**
   * `''` is a value of the rule: a string's, an `r.in()`'s that lists it — `optional()`/`nullable()`/`default()` keep it. Where
   * it never can be one (numbers, booleans, e-mail addresses, URLs, dates, lists, objects …) a form's empty field counts as missing.
   */
  readonly keepsEmpty: boolean;
  /** What a package marks its rule with (`r.value(…, { meta })`) — kept by every rule made from it; {@link metaOf} reads it. */
  readonly meta: Readonly<Record<symbol, unknown>>;
}

/** What a rule's `transform`, `custom` and database rules may be: a function, sync or async. */
type MaybePromise<T> = T | Promise<T>;

const isAsyncFunction = (fn: unknown): boolean => typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction';

/**
 * A rule — a Standard Schema object: `defineRequest`, `defineConfig`, jobs and query schemas take it like any other.
 * Immutable: every method returns a new rule. `Output` is what a valid value becomes, `Input` what may be sent.
 *
 * `optional()`, `nullable()` and `default()` come last (after the rules of the type): `r.string().max(255).optional()`.
 */
export class Rule<Output = unknown, Input = Output> implements StandardSchemaV1<Input, Output> {
  readonly '~standard': StandardSchemaV1<Input, Output>['~standard'];
  /** @internal — how the rule is built. */
  readonly '~rule': RuleDefinition;
  readonly #built: [Engine | undefined, Engine | undefined] = [undefined, undefined];

  /** @internal — built by `r`; an app writes `r.string()`, not `new Rule(…)`. */
  constructor(definition: RuleDefinition) {
    this['~rule'] = definition;
    this['~standard'] = {
      version: 1,
      vendor: 'marmeon',
      validate: (value, options) => engine.validate((context) => this['~engine'](context), definition.async, value, options) as never,
    };
  }

  /** @internal — the engine's schema for one validation, built once unless it depends on the request. */
  '~engine'(context: BuildContext): Engine {
    const definition = this['~rule'];
    const own = definition.live && !context.liveOptIn ? { ...context, liveOptIn: true } : context;
    if (!definition.contextual) {
      const slot = context.live ? 1 : 0;
      return (this.#built[slot] ??= build(definition, own));
    }
    return build(definition, own);
  }

  /** @internal — the same rule plus `step`, of the same class, so a string's rules stay at hand. */
  protected with(step: RuleStep, change: Partial<RuleDefinition> = {}): this {
    const definition = this['~rule'];
    const Class = this.constructor as new (definition: RuleDefinition) => this;
    return new Class({
      ...definition,
      ...change,
      steps: [...definition.steps, step],
      async: definition.async || step.async,
      contextual: definition.contextual || step.contextual,
    });
  }

  /**
   * The value may be missing (`undefined`): `{ bio?: string }`. An empty string stays one where the rule takes it — `r.string()`'s
   * `''` is a value (a subtitle cleared on purpose) — and is missing where it never is one (`r.integer()`, `r.email()` …).
   */
  optional(): Rule<Output | undefined, Input | undefined> {
    return this.#modified({ optional: true, nullable: false });
  }

  /** The value may be `null`: `website: string | null` — an empty string becomes `null` where the rule never takes it (`r.url()`). */
  nullable(): Rule<Output | null, Input | null> {
    return this.#modified({ optional: false, nullable: true });
  }

  /**
   * What a missing value becomes — the field is then always there: `page: r.integer().min(1).default(1)` (an empty string
   * too where the rule never takes it: `?page=`; `r.string()` keeps `''`). A list or an object is copied for every validation
   * (nobody shares it). In `r.query()` it is what an invalid value falls back to.
   */
  default(value: Exclude<Output, undefined>): Rule<Exclude<Output, undefined>, Input | undefined> {
    return this.#modified({ optional: true, nullable: false, fallback: { value } });
  }

  /** What the valid value becomes: `r.string().transform((tags) => tags.split(' '))`. An async function makes the rule async. */
  transform<To>(convert: (value: Output) => MaybePromise<To>): Rule<Awaited<To>, Input> {
    const async = isAsyncFunction(convert);
    const definition = this['~rule'];
    return new Rule({
      ...definition,
      steps: [...definition.steps, { build: () => engine.transform(convert, async), async, contextual: false }],
      async: definition.async || async,
    });
  }

  /**
   * A check of your own: return `false` (its message: `message`, else "The … field is invalid."),
   * a message (a translation key or a text), or nothing when the value is valid. `context.request` is the request's `resolve`,
   * `ctx` and whether it is live. An `async` check makes the rule async, and — like the database rules — it does not run in a live
   * validation unless the rule says `.live()`.
   *
   * ```ts
   * code: r.string().custom(async (code, { request }) => (await request!.resolve(Invites).valid(code)) || 'invites.validation.unknown')
   * ```
   */
  custom(check: CustomCheck<Output> | { readonly validate: CustomCheck<Output> }, message?: RuleMessage): this {
    return this.with(customStep(check, message));
  }

  /**
   * The value is in no row of `Repository`'s table yet (soft-deleted rows count) — a friendly message before the insert; the
   * unique index stays the truth. A rule of a request only (it gets the repository from the request). Not live: a live
   * validation never asks the database, so free and taken values get the same answer there — `.live()` turns that on. See
   * `docs/validation.md#database-rules-and-why-they-never-run-live`.
   */
  unique<R extends RepositoryLike, Ctx = any>(Repository: new (...args: any[]) => R, column: RepositoryColumnOf<R>, options: UniqueOptions<Ctx, QueryOfRepository<R>> = {}): this {
    return this.with(databaseStep('unique', Repository, column, options));
  }

  /** The value is in a row of `Repository`'s table (not soft-deleted). Not live, like {@link unique}. */
  exists<R extends RepositoryLike, Ctx = any>(Repository: new (...args: any[]) => R, column: RepositoryColumnOf<R>, options: ExistsOptions<Ctx, QueryOfRepository<R>> = {}): this {
    return this.with(databaseStep('exists', Repository, column, options));
  }

  /**
   * Runs this rule's database and async checks in a live validation too — for values whose being taken is no secret (a team's
   * slug in its own settings). Never for anything that tells whether an account exists. A rule of one value only: on an
   * object, a list or a union it throws — it would open every rule inside, the account's address too; put it on the field.
   */
  live(): this {
    if (this['~rule'].container) throw new TypeError(LIVE_ON_CONTAINER);
    const Class = this.constructor as new (definition: RuleDefinition) => this;
    return new Class({ ...this['~rule'], live: true });
  }

  #modified(modifier: Omit<engine.Modifier, 'keepsEmpty'>): Rule<any, any> {
    const definition = this['~rule'];
    const base = (context: BuildContext) => engine.modifiedEngine(this['~engine'](context), { ...modifier, keepsEmpty: definition.keepsEmpty }, definition.async);
    CONTENTS.set(base, { kind: 'modified', rule: this });
    return new Rule({
      base,
      steps: [],
      sizes: [],
      async: definition.async,
      contextual: definition.contextual,
      live: false,
      container: definition.container,
      keepsEmpty: definition.keepsEmpty,
      meta: definition.meta,
    });
  }
}

/** What `.live()` on an object, a list or a union says — at run time, and as the type `ObjectRule#live`'s `this` must have. */
export const LIVE_ON_CONTAINER =
  '.live() goes on the field whose being taken is no secret — r.object({ slug: r.string().unique(Teams, \'slug\').live() }) — never on an object, a list or a union: it would open every rule inside.';


function build(definition: RuleDefinition, context: BuildContext): Engine {
  const items = definition.steps.map((step) => step.build(context)).filter((item): item is Engine => item !== undefined);
  return engine.pipeEngine(definition.base(context, definition.sizes), items, definition.async);
}

/** A rule's base on its own. */
export function definition(base: (context: BuildContext, sizes: readonly engine.SizeGate[]) => Engine, parts: Partial<RuleDefinition> = {}): RuleDefinition {
  return { base, steps: [], sizes: [], async: false, contextual: false, live: false, container: false, keepsEmpty: false, meta: {}, ...parts };
}

/** A step that never depends on the request. */
export function step(item: () => Engine): RuleStep {
  let built: Engine | undefined;
  return { build: () => (built ??= item()), async: false, contextual: false };
}

/** What `.custom()` hands a check besides the value. */
export interface CustomContext {
  /** The request's `resolve`, `ctx` and whether it is live — undefined outside a request (a config, a job). */
  readonly request: ValidationContext | undefined;
}

export type CustomCheck<T> = (value: T, context: CustomContext) => MaybePromise<CheckAnswer>;

/** What `unique` and `exists` need of a repository (`Repository` of @marmeon/database): its query. */
export interface RepositoryLike {
  query(): unknown;
}

/** The columns of a repository's rows (from its `find()`), or any name for another class. */
export type RepositoryColumnOf<R> = R extends { find(id: never): Promise<infer Row> } ? Extract<keyof NonNullable<Row>, string> : string;

/** The query a repository's `query()` returns — what `where` of `unique` and `exists` receives and returns. */
export type QueryOfRepository<R> = R extends { query(): infer Q } ? Q : never;

export interface ExistsOptions<Ctx = any, Q = any> {
  /**
   * Narrows the rows that count — a tenant, say: `(query, ctx) => query.where('team_id', '=', ctx.user.team_id)`. `query` is the
   * repository's, so a wrong column is a compile error; annotate `ctx` with the context the request has. See
   * `docs/validation.md#database-rules-and-why-they-never-run-live`.
   */
  readonly where?: (query: Q, ctx: Ctx) => Q;
  /** Own message — a translation key, a text or `translatable()`'s (default: `marmeon.validation.exists`/`unique`). */
  readonly message?: RuleMessage;
}

export interface UniqueOptions<Ctx = any, Q = any> extends ExistsOptions<Ctx, Q> {
  /** A row that does not count — the one being edited: `(ctx) => ctx.user.id`. */
  readonly ignore?: (ctx: Ctx) => unknown;
  /** The column `ignore` names (default `id`). */
  readonly ignoreColumn?: string;
}

/** The step of `custom()`; `field` reports an object's check at one of its fields (undefined: at the rule itself). */
function customStep(check: CustomCheck<any> | { readonly validate: CustomCheck<any> }, message: RuleMessage | undefined, field?: string): RuleStep {
  const test = typeof check === 'function' ? check : check.validate.bind(check);
  const async = isAsyncFunction(test);
  const describe = message === undefined ? engine.message('custom') : engine.ownMessage(message);
  return {
    async,
    contextual: true,
    build: (context) => {
      if (async && context.live && !context.liveOptIn) return undefined;
      const answer = (value: unknown) => test(value, { request: context.request });
      return engine.customCheck(answer, describe, async, async && !context.liveOptIn, field);
    },
  };
}

function databaseStep(kind: 'unique' | 'exists', Repository: new (...args: any[]) => RepositoryLike, column: string, options: UniqueOptions): RuleStep {
  const describe = options.message === undefined ? engine.message(kind) : engine.ownMessage(options.message);
  return {
    async: true,
    contextual: true,
    build: (context) => {
      // Never in a live validation unless the rule says .live() — free and taken values get the same answer.
      if (context.live && !context.liveOptIn) return undefined;
      return engine.checkAsync(async (value) => {
        const request = context.request;
        if (!request) {
          throw new Error(`r.…${kind}() asks the database — it validates in a request (defineRequest), where it gets the app's resolve; this validation has none.`);
        }
        const repository = request.resolve(Repository) as RepositoryLike;
        let query = repository.query() as any;
        // Soft-deleted rows hold the unique index too: they count for unique (not for exists).
        if (kind === 'unique' && typeof query.withTrashed === 'function') query = query.withTrashed();
        query = query.select(column).where(column, '=', value);
        if (options.where) query = options.where(query, request.ctx);
        if (kind === 'unique' && options.ignore) {
          const ignored = await options.ignore(request.ctx);
          if (ignored !== undefined && ignored !== null) query = query.where(options.ignoreColumn ?? 'id', '<>', ignored);
        }
        const row = await query.limit(1).executeTakeFirst();
        return kind === 'unique' ? row === undefined : row !== undefined;
      }, context.liveOptIn ? describe : engine.notLive(describe));
    },
  };
}

// ——— Sizes ———

type Sized = 'string' | 'number' | 'array';

const sizeOf = (kind: Sized, value: any): number => (kind === 'string' ? [...(value as string)].length : kind === 'array' ? (value as unknown[]).length : (value as number));

function sizeMessage(kind: Sized, rule: 'min' | 'max' | 'between', min: number | undefined, max: number | undefined): engine.Message {
  for (const bound of [min, max]) {
    if (bound !== undefined && !Number.isFinite(bound)) throw new RangeError(`${rule}() takes finite numbers, got ${bound}.`);
  }
  const params = rule === 'min' ? { min } : rule === 'max' ? { max } : { min, max };
  return engine.message(`${rule}.${kind}` as TextKey, params);
}

function sizeStep(kind: Sized, rule: 'min' | 'max' | 'between', min: number | undefined, max: number | undefined): RuleStep {
  const message = sizeMessage(kind, rule, min, max);
  return step(() => engine.check((value) => (min === undefined || sizeOf(kind, value) >= min) && (max === undefined || sizeOf(kind, value) <= max), message));
}

/** A list's size rule: its items count, and it runs before the first of them. */
function sizeGate(rule: 'min' | 'max' | 'between', min: number | undefined, max: number | undefined): engine.SizeGate {
  return { test: (size) => (min === undefined || size >= min) && (max === undefined || size <= max), message: sizeMessage('array', rule, min, max) };
}

/**
 * A string — the type of form fields. `''` is a string: `.optional()`, `.nullable()` and `.default()` keep it, `.required()`
 * (or `.min(1)`) asks for some text. The formats `email()`, `url()`, `uuid()`, `date()` and `isoTimestamp()` never take `''`: there it
 * is a form's empty field and counts as missing. Lengths count characters (code points).
 */
export class StringRule extends Rule<string, string> {
  /** Takes the whitespace off both ends first — before the checks after it. */
  trim(): this {
    return this.with(step(engine.trim));
  }

  /** Lower case — for what is compared case-insensitively, like an e-mail address. */
  lowercase(): this {
    return this.with(step(engine.toLowerCase));
  }

  /** Not empty (put it after `.trim()`: whitespace is no text). */
  required(): this {
    return this.with(step(() => engine.check((value: string) => value !== '', engine.message('required'))));
  }

  /** At least `min` characters. */
  min(min: number): this {
    return this.with(sizeStep('string', 'min', min, undefined));
  }

  /** At most `max` characters. */
  max(max: number): this {
    return this.with(sizeStep('string', 'max', undefined, max));
  }

  /** From `min` to `max` characters. */
  between(min: number, max: number): this {
    return this.with(sizeStep('string', 'between', min, max));
  }

  /** An e-mail address (the practical pattern: `name@domain.tld`). */
  email(): this {
    return this.with(step(engine.email), FORMAT);
  }

  /**
   * An absolute URL — **http or https** unless `protocols` names others: a `javascript:` URL in an `href` would run in every
   * visitor's browser.
   */
  url({ protocols = ['http', 'https'] }: { readonly protocols?: readonly string[] } = {}): this {
    const allowed = new Set(protocols.map((protocol) => `${protocol.replace(/:$/, '').toLowerCase()}:`));
    return this.with(step(() => engine.check((value: string) => isUrl(value, allowed), engine.message('url'))), FORMAT);
  }

  /** A UUID (any version). */
  uuid(): this {
    return this.with(step(engine.uuid), FORMAT);
  }

  /** Matches `pattern` (its `g`/`y` flags are dropped). `message`: a translation key or a text — default "The … field format is invalid." */
  regex(pattern: RegExp, message?: RuleMessage): this {
    return this.with(step(() => engine.regex(pattern, message === undefined ? engine.message('regex') : engine.ownMessage(message))));
  }

  /** A calendar date as `<input type="date">` sends it: `2026-10-07` (a day that exists). Stays a string. */
  date(): this {
    return this.with(step(() => engine.check(isDate, engine.message('date'))), FORMAT);
  }

  /** A date and time in ISO 8601 (`2026-10-07T14:30:00Z`, with an offset or `Z`). Stays a string. */
  isoTimestamp(): this {
    return this.with(step(engine.isoTimestamp), FORMAT);
  }
}

/** A format `''` never matches: an empty field is a missing one there. */
const FORMAT = { keepsEmpty: false } as const;

function isUrl(value: string, protocols: ReadonlySet<string>): boolean {
  if (/\s/.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (!protocols.has(url.protocol)) return false;
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname !== '' : true;
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A number, or a string that spells one (a form, a URL) — becomes a number. */
export class NumberRule extends Rule<number, number | `${number}`> {
  /** A whole number (a safe integer). */
  integer(): this {
    return this.with(step(() => engine.check((value: number) => Number.isSafeInteger(value), engine.message('integer'))));
  }

  /** At least `min`. */
  min(min: number): this {
    return this.with(sizeStep('number', 'min', min, undefined));
  }

  /** At most `max`. */
  max(max: number): this {
    return this.with(sizeStep('number', 'max', undefined, max));
  }

  /** From `min` to `max`. */
  between(min: number, max: number): this {
    return this.with(sizeStep('number', 'between', min, max));
  }
}

/** A list, each item checked by its rule (`r.array(r.string().max(30))`). Sizes count items. */
export class ArrayRule<Item, ItemInput, In = ItemInput[]> extends Rule<Item[], In> {
  /** Not on a list: put `.live()` on its item rule — `r.array(r.string().exists(Tags, 'slug').live())`; it throws here. */
  override live(this: typeof LIVE_ON_CONTAINER): never {
    throw new TypeError(LIVE_ON_CONTAINER);
  }

  /** Not empty. */
  required(): this {
    return this.with(step(() => engine.check((value: unknown[]) => value.length > 0, engine.message('required'))));
  }

  /** At least `min` items. */
  min(min: number): this {
    return this.#sized(sizeGate('min', min, undefined));
  }

  /** At most `max` items. */
  max(max: number): this {
    return this.#sized(sizeGate('max', undefined, max));
  }

  /** From `min` to `max` items. */
  between(min: number, max: number): this {
    return this.#sized(sizeGate('between', min, max));
  }

  #sized(gate: engine.SizeGate): this {
    const definition = this['~rule'];
    const Class = this.constructor as new (definition: RuleDefinition) => this;
    return new Class({ ...definition, sizes: [...definition.sizes, gate] });
  }
}

// ——— Objects ———

/** The fields of an object: a rule each. */
export type Shape = { readonly [field: string]: Rule<any, any> };

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type MissingKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
/** Keys whose value may be undefined are optional — what a form may leave out, what a handler may not find. */
type Fields<T> = Simplify<{ [K in Exclude<keyof T, MissingKeys<T>>]: T[K] } & { [K in MissingKeys<T>]?: T[K] }>;

/** What an object of `S` becomes once valid. */
export type ShapeOutput<S extends Shape> = Fields<{ [K in keyof S]: InferOutput<S[K]> }>;
/** What an object of `S` takes. */
export type ShapeInput<S extends Shape> = Fields<{ [K in keyof S]: InferInput<S[K]> }>;

interface ObjectParts {
  readonly shape: Shape;
  readonly whens: readonly { readonly condition: (data: any) => boolean; readonly shape: Shape }[];
  readonly confirmations: readonly Confirmation[];
}

/**
 * An object of fields — a form's body, a query. Fields the shape does not name are left out. `When` holds the fields of
 * `.when()`: there only when their condition holds.
 */
export class ObjectRule<S extends Shape, When extends Shape = {}> extends Rule<Simplify<ShapeOutput<S> & Partial<ShapeOutput<When>>>, Simplify<ShapeInput<S> & Partial<ShapeInput<When>>>> {
  /**
   * The object's fields, a rule each (not those of `.when()`) — spread them into another object:
   * `r.query({ ...MembersTable.query.entries, tab: r.in(['all', 'mine']).default('all') })`.
   */
  get entries(): S {
    return objectParts(this).shape as S;
  }

  /**
   * `custom()` of an object: the check gets the object once all its fields are valid. Its message goes under the key `_` of the
   * errors; `{ field }` reports it at one of the fields instead, where a form shows it. See `docs/validation.md#objects`.
   *
   * ```ts
   * r.object({ starts_at: r.string(), ends_at: r.string() }).custom((event) => event.ends_at > event.starts_at, { message: 'The end is before the start.', field: 'ends_at' })
   * ```
   */
  override custom(
    check: CustomCheck<Simplify<ShapeOutput<S> & Partial<ShapeOutput<When>>>> | { readonly validate: CustomCheck<Simplify<ShapeOutput<S> & Partial<ShapeOutput<When>>>> },
    options?: RuleMessage | { readonly message?: RuleMessage; readonly field?: (keyof S | keyof When) & string },
  ): this {
    const { message, field } = typeof options === 'object' ? options : { message: options, field: undefined };
    return this.with(customStep(check, message, field));
  }

  /** Not on an object: put `.live()` on the field whose being taken is no secret — it throws here. */
  override live(this: typeof LIVE_ON_CONTAINER): never {
    throw new TypeError(LIVE_ON_CONTAINER);
  }

  /**
   * Fields checked only when `condition` holds for the others, else left out:
   *
   * ```ts
   * r.object({ kind: r.in(['person', 'company']) }).when((data) => data.kind === 'company', { vat: r.string().trim().required() })
   * ```
   */
  when<const W extends Shape>(condition: (data: ShapeOutput<S>) => boolean, fields: W): ObjectRule<S, Simplify<When & W>> {
    const parts = objectParts(this);
    return new ObjectRule(objectDefinition({ ...parts, whens: [...parts.whens, { condition, shape: fields }] }, this['~rule'])) as never;
  }

  /**
   * `confirmation` (default `<field>_confirmation`) repeats `field` — reported on the confirmation field (where a form shows
   * it) once `field` itself is valid.
   */
  confirmed(field: keyof S & string, confirmation: string = `${field}_confirmation`): this {
    const parts = objectParts(this);
    return new ObjectRule(objectDefinition({ ...parts, confirmations: [...parts.confirmations, { field, confirmation }] }, this['~rule'])) as this;
  }
}

const PARTS = new WeakMap<RuleDefinition, ObjectParts>();

/**
 * What a rule is marked with under `key` (`r.value(…, { meta: { [key]: … } })`) — through every rule made from it: `.nullable()`,
 * `.custom()`, `.transform()` … Undefined for anything else (another library's schema too).
 */
export function metaOf(rule: unknown, key: symbol): unknown {
  const definition = (rule as { readonly '~rule'?: RuleDefinition } | null | undefined)?.['~rule'];
  return definition?.meta?.[key];
}

/** What a rule holds besides its own checks — the rules inside it. */
export type RuleContents =
  | { readonly kind: 'object'; readonly fields: Shape; readonly conditional: readonly Shape[] }
  | { readonly kind: 'list'; readonly item: Rule<any, any> }
  | { readonly kind: 'union'; readonly options: readonly Rule<any, any>[] }
  /** `.optional()`, `.nullable()` or `.default()` of `rule`. */
  | { readonly kind: 'modified'; readonly rule: Rule<any, any> };

/** The contents of the rules that hold others, by their base (a rule made from it by `.custom()` or `.transform()` keeps the base). */
const CONTENTS = new WeakMap<object, RuleContents>();

/** Records what the rule of `base` holds — {@link contentsOf} reads it back. */
export function holding<T extends RuleDefinition>(definition: T, contents: RuleContents): T {
  CONTENTS.set(definition.base, contents);
  return definition;
}

/**
 * The rules inside `rule` — an object's fields, a list's item, a union's options, what `.optional()`/`.nullable()`/`.default()`
 * wrap — or undefined for a rule that holds none (and for another library's schema).
 */
export function contentsOf(rule: unknown): RuleContents | undefined {
  const base = (rule as { readonly '~rule'?: RuleDefinition } | null | undefined)?.['~rule']?.base;
  return base === undefined ? undefined : CONTENTS.get(base);
}

function objectParts(rule: Rule<any, any>): ObjectParts {
  // The object's parts belong to its base; steps added later (`.custom()`) keep the base.
  const parts = PARTS.get(rule['~rule'].base as never);
  if (!parts) throw new TypeError('An object rule without its fields.');
  return parts;
}

/** An object's definition: its base builds the fields' rules; `previous` lends its steps (an object that had `.custom()` keeps it). */
export function objectDefinition(parts: ObjectParts, previous?: RuleDefinition): RuleDefinition {
  const rules = [...Object.values(parts.shape), ...parts.whens.flatMap((when) => Object.values(when.shape))];
  const async = rules.some((rule) => rule['~rule'].async);
  const base = (context: BuildContext): Engine => {
    const entries = (shape: Shape) => Object.fromEntries(Object.entries(shape).map(([key, rule]) => [key, rule['~engine'](context)]));
    const whens: ConditionalFields[] = parts.whens.map((when) => ({ condition: when.condition, entries: entries(when.shape) }));
    return engine.objectEngine(entries(parts.shape), whens, parts.confirmations, async);
  };
  PARTS.set(base as never, parts);
  CONTENTS.set(base, { kind: 'object', fields: parts.shape, conditional: parts.whens.map((when) => when.shape) });
  const steps = previous?.steps ?? [];
  return {
    base,
    steps,
    sizes: [],
    async: async || steps.some((s) => s.async),
    contextual: rules.some((rule) => rule['~rule'].contextual) || steps.some((s) => s.contextual),
    live: previous?.live ?? false,
    container: true,
    keepsEmpty: false,
    meta: previous?.meta ?? {},
  };
}

export function objectRule<S extends Shape>(shape: S): ObjectRule<S> {
  for (const [key, rule] of Object.entries(shape)) {
    if (!(rule instanceof Rule)) throw new TypeError(`Field '${key}' is no rule of @marmeon/validation — r.object() takes rules (r.string(), r.integer() …).`);
  }
  return new ObjectRule(objectDefinition({ shape, whens: [], confirmations: [] }));
}
