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
  readonly base: (context: BuildContext) => Engine;
  readonly steps: readonly RuleStep[];
  readonly async: boolean;
  readonly contextual: boolean;
  /** `.live()`: its rules run in a live validation too. */
  readonly live: boolean;
  /** An object, a list or a union: its rules are other rules — `.live()` belongs on them, never on it (E197). */
  readonly container: boolean;
  /** How a message names a field: in words (`password confirmation`) or as written (`APP_PORT`, for `.env`). */
  readonly attributes: 'humanized' | 'raw';
  /** What a package marks its rule with (`r.value(…, { meta })`) — kept by every rule made from it; {@link metaOf} reads it. */
  readonly meta: Readonly<Record<symbol, unknown>>;
}

/** What a rule's `transform`, `custom` and database rules may be: a function, sync or async. */
type MaybePromise<T> = T | Promise<T>;

const isAsyncFunction = (fn: unknown): boolean => typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction';

/**
 * A rule — a Standard Schema object (E197): `defineRequest`, `defineConfig`, jobs and query schemas take it like any other.
 * Immutable: every method returns a new rule. `Output` is what a valid value becomes, `Input` what may be sent.
 *
 * `optional()`, `nullable()` and `default()` come last (after the rules of the type): `r.string().max(255).optional()`.
 */
export class Rule<Output = unknown, Input = Output> implements StandardSchemaV1<Input, Output> {
  readonly '~standard': StandardSchemaV1<Input, Output>['~standard'];
  /** How the rule is built — internal. */
  readonly '~rule': RuleDefinition;
  readonly #built: [Engine | undefined, Engine | undefined] = [undefined, undefined];

  constructor(definition: RuleDefinition) {
    this['~rule'] = definition;
    this['~standard'] = {
      version: 1,
      vendor: 'marmeon',
      validate: (value, options) => engine.validate((context) => this['~engine'](context), definition.async, value, options, definition.attributes) as never,
    };
  }

  /** The engine's schema for one validation — built once, unless it depends on the request (internal). */
  '~engine'(context: BuildContext): Engine {
    const definition = this['~rule'];
    const own = definition.live && !context.liveOptIn ? { ...context, liveOptIn: true } : context;
    if (!definition.contextual) {
      const slot = context.live ? 1 : 0;
      return (this.#built[slot] ??= build(definition, own));
    }
    return build(definition, own);
  }

  /** The same rule plus `step` — of the same class, so a string's rules stay at hand. */
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

  /** The value may be missing (`undefined`; an empty string counts as missing): `{ bio?: string }`. */
  optional(): Rule<Output | undefined, Input | undefined> {
    return this.#modified({ optional: true, nullable: false });
  }

  /** The value may be `null` (an empty string becomes `null`, Laravel's ConvertEmptyStringsToNull): `website: string | null`. */
  nullable(): Rule<Output | null, Input | null> {
    return this.#modified({ optional: false, nullable: true });
  }

  /**
   * What a missing value (or an empty string) becomes — the field is then always there: `page: r.integer().min(1).default(1)`. A
   * list or an object is copied for every validation (nobody shares it). In `r.query()` it is what an invalid value falls back to (E56).
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
   * A check of your own — Laravel's `ValidationRule`: return `false` (its message: `message`, else "The … field is invalid."),
   * a message (a translation key or a text), or nothing when the value is valid. `context.request` is the request's `resolve`,
   * `ctx` and whether it is live. An `async` check makes the rule async, and — like the database rules — it does not run in a live
   * validation unless the rule says `.live()` (E197).
   *
   * ```ts
   * code: r.string().custom(async (code, { request }) => (await request!.resolve(Invites).valid(code)) || 'invites.validation.unknown')
   * ```
   */
  custom(check: CustomCheck<Output> | { readonly validate: CustomCheck<Output> }, message?: RuleMessage): this {
    const test = typeof check === 'function' ? check : check.validate.bind(check);
    const async = isAsyncFunction(test);
    const describe = message === undefined ? engine.message('custom') : engine.ownMessage(message);
    return this.with({
      async,
      contextual: true,
      build: (context) => {
        if (async && context.live && !context.liveOptIn) return undefined;
        const answer = (value: Output) => test(value, { request: context.request });
        return engine.customCheck(answer, describe, async, async && !context.liveOptIn);
      },
    });
  }

  /**
   * The value is in no row of `Repository`'s table yet — Laravel's `unique`, for a friendly message before the insert. The
   * unique index stays the truth (two requests at once): `failOnDuplicate()` of @marmeon/database turns its conflict into the same
   * 422. Rows of the table count even when soft-deleted (the index holds them too). Gets the repository from the request
   * (`resolve`) — a rule of a request only.
   *
   * Not live (E187/E193/E197): a live validation (E62) never asks the database — free and taken values get the same answer
   * there; the submit tells. `.live()` turns that on, where whether a value is taken is no secret.
   *
   * ```ts
   * email: r.string().trim().lowercase().email().unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),
   * ```
   */
  unique<R extends RepositoryLike, Ctx = any>(Repository: new (...args: any[]) => R, column: ColumnOf<R>, options: UniqueOptions<Ctx> = {}): this {
    return this.with(databaseStep('unique', Repository, column, options));
  }

  /** The value is in a row of `Repository`'s table (not soft-deleted) — Laravel's `exists`. Not live, like {@link unique}. */
  exists<R extends RepositoryLike, Ctx = any>(Repository: new (...args: any[]) => R, column: ColumnOf<R>, options: ExistsOptions<Ctx> = {}): this {
    return this.with(databaseStep('exists', Repository, column, options));
  }

  /**
   * Runs this rule's database and async checks in a live validation too (E62) — for values whose being taken is no secret (a team's
   * slug in its own settings). Never for anything that tells whether an account exists (E187/E193). A rule of one value only: on an
   * object, a list or a union it throws — it would open every rule inside, the account's address too; put it on the field.
   */
  live(): this {
    if (this['~rule'].container) throw new TypeError(LIVE_ON_CONTAINER);
    const Class = this.constructor as new (definition: RuleDefinition) => this;
    return new Class({ ...this['~rule'], live: true });
  }

  #modified(modifier: engine.Modifier): Rule<any, any> {
    const definition = this['~rule'];
    return new Rule({
      base: (context) => engine.modifiedEngine(this['~engine'](context), modifier, definition.async),
      steps: [],
      async: definition.async,
      contextual: definition.contextual,
      live: false,
      container: definition.container,
      attributes: definition.attributes,
      meta: definition.meta,
    });
  }
}

/** What `.live()` on an object, a list or a union says — at run time, and as the type `ObjectRule#live`'s `this` must have. */
export const LIVE_ON_CONTAINER =
  '.live() goes on the field whose being taken is no secret — r.object({ slug: r.string().unique(Teams, \'slug\').live() }) — never on an object, a list or a union: it would open every rule inside (E197).';


function build(definition: RuleDefinition, context: BuildContext): Engine {
  const items = definition.steps.map((step) => step.build(context)).filter((item): item is Engine => item !== undefined);
  return engine.pipeEngine(definition.base(context), items, definition.async);
}

/** A rule's base on its own. */
export function definition(base: (context: BuildContext) => Engine, parts: Partial<RuleDefinition> = {}): RuleDefinition {
  return { base, steps: [], async: false, contextual: false, live: false, container: false, attributes: 'humanized', meta: {}, ...parts };
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
export type ColumnOf<R> = R extends { find(id: never): Promise<infer Row> } ? Extract<keyof NonNullable<Row>, string> : string;

export interface ExistsOptions<Ctx = any> {
  /** Narrows the rows that count — a tenant, say: `(query, ctx) => query.where('team_id', '=', ctx.user.team_id)`. */
  readonly where?: (query: any, ctx: Ctx) => any;
  /** Own message — a translation key, a text or `translatable()`'s (default: `marmeon.validation.exists`/`unique`). */
  readonly message?: RuleMessage;
}

export interface UniqueOptions<Ctx = any> extends ExistsOptions<Ctx> {
  /** A row that does not count — the one being edited: `(ctx) => ctx.user.id` (Laravel's `ignore()`). */
  readonly ignore?: (ctx: Ctx) => unknown;
  /** The column `ignore` names (default `id`). */
  readonly ignoreColumn?: string;
}

function databaseStep(kind: 'unique' | 'exists', Repository: new (...args: any[]) => RepositoryLike, column: string, options: UniqueOptions): RuleStep {
  const describe = options.message === undefined ? engine.message(kind) : engine.ownMessage(options.message);
  return {
    async: true,
    contextual: true,
    build: (context) => {
      // E197: never in a live validation unless the rule says .live() — free and taken values get the same answer (E187/E193).
      if (context.live && !context.liveOptIn) return undefined;
      return engine.checkAsync(async (value) => {
        const request = context.request;
        if (!request) {
          throw new Error(`r.…${kind}() asks the database — it validates in a request (defineRequest), where it gets the app's resolve; this validation has none.`);
        }
        const repository = request.resolve(Repository) as RepositoryLike & { withTrashed?: () => unknown };
        // Soft-deleted rows hold the unique index too: they count for unique (not for exists).
        let query = (kind === 'unique' && typeof repository.withTrashed === 'function' ? repository.withTrashed() : repository.query()) as any;
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

function sizeStep(kind: Sized, rule: 'min' | 'max' | 'between', min: number | undefined, max: number | undefined): RuleStep {
  for (const bound of [min, max]) {
    if (bound !== undefined && !Number.isFinite(bound)) throw new RangeError(`${rule}() takes finite numbers, got ${bound}.`);
  }
  const params = rule === 'min' ? { min } : rule === 'max' ? { max } : { min, max };
  return step(() =>
    engine.check(
      (value) => (min === undefined || sizeOf(kind, value) >= min) && (max === undefined || sizeOf(kind, value) <= max),
      engine.message(`${rule}.${kind}` as TextKey, params),
    ),
  );
}

/** A string — the type of form fields. `'' ` is a string: `.required()` asks for some text. Lengths count characters (code points). */
export class StringRule extends Rule<string, string> {
  /** Takes the whitespace off both ends first — before the checks after it. */
  trim(): this {
    return this.with(step(engine.trim));
  }

  /** Lower case — for what is compared case-insensitively, like an e-mail address. */
  lowercase(): this {
    return this.with(step(engine.toLowerCase));
  }

  /** Not empty — Laravel's `required` (put it after `.trim()`: whitespace is no text). */
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
    return this.with(step(engine.email));
  }

  /**
   * An absolute URL — **http or https** unless `protocols` names others: a `javascript:` URL in an `href` would run in every
   * visitor's browser.
   */
  url({ protocols = ['http', 'https'] }: { readonly protocols?: readonly string[] } = {}): this {
    const allowed = new Set(protocols.map((protocol) => `${protocol.replace(/:$/, '').toLowerCase()}:`));
    return this.with(step(() => engine.check((value: string) => isUrl(value, allowed), engine.message('url'))));
  }

  /** A UUID (any version). */
  uuid(): this {
    return this.with(step(engine.uuid));
  }

  /** Matches `pattern` (its `g`/`y` flags are dropped). `message`: a translation key or a text — default "The … field format is invalid." */
  regex(pattern: RegExp, message?: RuleMessage): this {
    return this.with(step(() => engine.regex(pattern, message === undefined ? engine.message('regex') : engine.ownMessage(message))));
  }

  /** A calendar date as `<input type="date">` sends it: `2026-10-07` (a day that exists). Stays a string. */
  date(): this {
    return this.with(step(() => engine.check(isDate, engine.message('date'))));
  }

  /** A date and time in ISO 8601 (`2026-10-07T14:30:00Z`, with an offset or `Z`). Stays a string. */
  isoTimestamp(): this {
    return this.with(step(engine.isoTimestamp));
  }
}

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

/** A number, or a string that spells one (a form, a URL, `.env`) — becomes a number. */
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
  /** Not on a list (E197): put `.live()` on its item rule — `r.array(r.string().exists(Tags, 'slug').live())`; it throws here. */
  override live(this: typeof LIVE_ON_CONTAINER): never {
    throw new TypeError(LIVE_ON_CONTAINER);
  }

  /** Not empty. */
  required(): this {
    return this.with(step(() => engine.check((value: unknown[]) => value.length > 0, engine.message('required'))));
  }

  /** At least `min` items. */
  min(min: number): this {
    return this.with(sizeStep('array', 'min', min, undefined));
  }

  /** At most `max` items. */
  max(max: number): this {
    return this.with(sizeStep('array', 'max', undefined, max));
  }

  /** From `min` to `max` items. */
  between(min: number, max: number): this {
    return this.with(sizeStep('array', 'between', min, max));
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
 * An object of fields — a form's body, a query, `.env`. Fields the shape does not name are left out. `When` holds the fields of
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

  /** Not on an object (E197): put `.live()` on the field whose being taken is no secret — it throws here. */
  override live(this: typeof LIVE_ON_CONTAINER): never {
    throw new TypeError(LIVE_ON_CONTAINER);
  }

  /**
   * Fields checked only when `condition` holds for the others (Laravel's `sometimes`/`required_if`), else left out:
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
   * `confirmation` (default `<field>_confirmation`) repeats `field` — Laravel's `confirmed`, reported on the confirmation field
   * (where a form shows it) once `field` itself is valid.
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

function objectParts(rule: Rule<any, any>): ObjectParts {
  // The object's parts belong to its base; steps added later (`.custom()`) keep the base.
  const parts = PARTS.get(rule['~rule'].base as never);
  if (!parts) throw new TypeError('An object rule without its fields.');
  return parts;
}

/** An object's definition: its base builds the fields' rules; `previous` lends its steps (an object that had `.custom()` keeps it). */
export function objectDefinition(parts: ObjectParts, previous?: RuleDefinition, attributes: 'humanized' | 'raw' = previous?.attributes ?? 'humanized'): RuleDefinition {
  const rules = [...Object.values(parts.shape), ...parts.whens.flatMap((when) => Object.values(when.shape))];
  const async = rules.some((rule) => rule['~rule'].async);
  const base = (context: BuildContext): Engine => {
    const entries = (shape: Shape) => Object.fromEntries(Object.entries(shape).map(([key, rule]) => [key, rule['~engine'](context)]));
    const whens: ConditionalFields[] = parts.whens.map((when) => ({ condition: when.condition, entries: entries(when.shape) }));
    return engine.objectEngine(entries(parts.shape), whens, parts.confirmations, async);
  };
  PARTS.set(base as never, parts);
  const steps = previous?.steps ?? [];
  return {
    base,
    steps,
    async: async || steps.some((s) => s.async),
    contextual: rules.some((rule) => rule['~rule'].contextual) || steps.some((s) => s.contextual),
    live: previous?.live ?? false,
    container: true,
    attributes,
    meta: previous?.meta ?? {},
  };
}

export function objectRule<S extends Shape>(shape: S, attributes: 'humanized' | 'raw' = 'humanized'): ObjectRule<S> {
  for (const [key, rule] of Object.entries(shape)) {
    if (!(rule instanceof Rule)) throw new TypeError(`Field '${key}' is no rule of @marmeon/validation — r.object() takes rules (r.string(), r.integer() …).`);
  }
  return new ObjectRule(objectDefinition({ shape, whens: [], confirmations: [] }, undefined, attributes));
}
