import type { InferInput, InferOutput } from '@marmeon/core';
import * as engine from './engine.ts';
import type { RuleMessage } from './engine.ts';
import { ArrayRule, definition, NumberRule, objectRule, Rule, StringRule, type ObjectRule, type Shape } from './rule.ts';

/** A number option of `r.in()` as a form or a URL sends it: `25` → `'25'`. */
type Spelled<T> = T extends number ? `${T}` : never;

/** What `r.boolean()` takes: true/false, and what forms and URLs say for them. */
export type BooleanInput = boolean | 0 | 1 | '0' | '1' | 'true' | 'false' | 'on' | 'off' | 'yes' | 'no';

/** What `r.accepted()` takes — what a checkbox may send (a form's state starts at `false`); only a yes passes. */
export type AcceptedInput = BooleanInput;

type InputOf<R> = R extends Rule<any, any> ? InferInput<R> : never;
type OutputOf<R> = R extends Rule<any, any> ? InferOutput<R> : never;

/**
 * `S` when every field can be read from a URL — the message the compiler shows otherwise (E56): a query is parsed field by field,
 * an invalid field falls back to its default, and a URL never answers 422.
 */
export type CheckQueryFields<S extends Shape> = {
  [K in keyof S]: undefined extends InputOf<S[K]>
    ? [Extract<Exclude<InputOf<S[K]>, undefined>, string | readonly string[]>] extends [never]
      ? `Query field '${K & string}' is read from the URL as text — give it a rule that takes a string: r.string(), r.integer(), r.boolean(), r.in([…]), r.array(…)`
      : S[K]
    : `Query field '${K & string}' needs .default(…) — a query is parsed field by field and never answers 422; .optional() leaves it undefined`;
};

const numberEngine = () => engine.typed('number', (value) => engine.toNumber(value) !== undefined, engine.toNumber);

function numberRule(): NumberRule {
  return new NumberRule(definition(numberEngine));
}

function stringRule(): StringRule {
  // `''` is a string (E208): a modifier keeps it — the formats (email(), url() …) say otherwise.
  return new StringRule(definition(engine.stringEngine, { keepsEmpty: true }));
}

function choice<const T extends readonly (string | number)[]>(values: T, key: 'in'): Rule<T[number], T[number] | Spelled<T[number]>> {
  if (values.length === 0) throw new RangeError('r.in() needs at least one value.');
  const spelled = new Map<unknown, T[number]>();
  for (const value of values) {
    spelled.set(value, value);
    if (typeof value === 'number') spelled.set(String(value), value);
  }
  // E208: `''` is a value only where it is one of the options; else it is a form's empty field — missing (a `<select>`'s placeholder).
  return new Rule(definition(() => engine.typed(key, (value) => spelled.has(value), (value) => spelled.get(value)), { keepsEmpty: spelled.has('') }));
}

/**
 * The rules (E197) — Laravel's names, typed: each builds a Standard Schema object that `defineRequest`, a job's
 * `static schema` and `parseQuery` take. Messages come in the request's language (`marmeon.validation.*`, English and German in
 * @marmeon/i18n; English without it), the first problem of a field only (`bail`).
 *
 * ```ts
 * import { rules as r } from '@marmeon/validation';
 *
 * schema: r.object({
 *   name:    r.string().trim().required().max(255),
 *   email:   r.string().trim().lowercase().required().email().max(255).unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),
 *   website: r.url().nullable(),
 *   tags:    r.array(r.string().max(30)).max(10).default([]),
 * }),
 * query: r.query({ sort: r.in(['name', '-name']).default('name'), page: r.integer().min(1).default(1) }),
 * ```
 */
export const rules = {
  /** A string (`''` too, also with `.optional()`/`.nullable()`/`.default()`, E208 — `.required()` asks for some text). */
  string: stringRule,

  /** A number — or a string that spells one (`'42'`, what a form or a URL sends): becomes a number. */
  number: numberRule,

  /** A whole number — or a string that spells one. */
  integer: (): NumberRule => numberRule().integer(),

  /** true or false — and `1`/`0`, `'on'`/`'off'`, `'yes'`/`'no'`, `'true'`/`'false'` (forms, URLs). */
  boolean: (): Rule<boolean, BooleanInput> => new Rule(definition(() => engine.typed('boolean', (value) => engine.toBoolean(value) !== undefined, engine.toBoolean))),

  /** Accepted — a ticked checkbox (`on`), `yes`, `1`, `true` — Laravel's `accepted` (terms of service). Becomes `true`. */
  accepted: (): Rule<true, AcceptedInput> =>
    // Missing is "must be accepted" too (an unticked checkbox sends nothing), not "required".
    new Rule(definition(() => engine.runsWhenMissing(engine.typed('accepted', (value) => engine.toBoolean(value) === true, () => true, engine.message('accepted'))))),

  /**
   * One of `values` — Laravel's `in`. Numbers are taken as a form or a URL spells them too (`'25'` for `25`). `''` is a value only
   * when it is one of them; else an empty field (a `<select>`'s placeholder) counts as missing for `.optional()`/`.default()` (E208).
   */
  in: <const T extends readonly [string | number, ...(string | number)[]]>(values: T): Rule<T[number], T[number] | Spelled<T[number]>> => choice(values, 'in'),

  /** Exactly `value`. */
  literal: <const T extends string | number>(value: T): Rule<T, T | Spelled<T>> => choice([value] as const, 'in') as never,

  /** One of the rules — the first that takes the value. */
  union: <const R extends readonly [Rule<any, any>, ...Rule<any, any>[]]>(options: R): Rule<OutputOf<R[number]>, InputOf<R[number]>> => {
    const async = options.some((option) => option['~rule'].async);
    return new Rule(
      definition((context) => engine.unionEngine(options.map((option) => option['~engine'](context)), async), {
        async,
        contextual: options.some((option) => option['~rule'].contextual),
        container: true,
        // `''` is a value when one of the rules takes it (E208).
        keepsEmpty: options.some((option) => option['~rule'].keepsEmpty),
      }),
    );
  },

  /**
   * A value of a type of your own — what a package brings (an upload of @marmeon/storage) or a value only a check can describe:
   * `check` gets the value — a missing one too (`undefined`) — and answers what is wrong with it (a translation key, a text or
   * `translatable()`'s message) or nothing; the value is taken as it is. Synchronous (an async check: `.custom()` after it).
   * `meta` marks the rule and every rule made from it (`.nullable()`, `.custom()` …) — `metaOf(rule, key)` reads it.
   *
   * ```ts
   * const slug = r.value<string>((value) => (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? undefined : 'teams.validation.slug'));
   * ```
   */
  value: <Output, Input = Output>(check: (value: unknown) => RuleMessage | undefined | void, options: { readonly meta?: Readonly<Record<symbol, unknown>> } = {}): Rule<Output, Input> =>
    new Rule(definition(() => engine.valueEngine(check), { meta: options.meta ?? {} })),

  /** An object of fields — a form's body. Fields the shape does not name are left out. */
  object: <const S extends Shape>(shape: S): ObjectRule<S> => objectRule(shape),

  /** A list, each item checked by `item`. */
  array: <Item extends Rule<any, any>>(item: Item): ArrayRule<InferOutput<Item>, InferInput<Item>> =>
    new ArrayRule(
      definition((context) => engine.arrayEngine(item['~engine'](context), item['~rule'].async), {
        async: item['~rule'].async,
        contextual: item['~rule'].contextual,
        container: true,
      }),
    ),

  /** An e-mail address — `r.string().email()`. */
  email: (): StringRule => stringRule().email(),

  /** An absolute http(s) URL — `r.string().url()` (other protocols: `r.string().url({ protocols: [...] })`). */
  url: (options?: { readonly protocols?: readonly string[] }): StringRule => stringRule().url(options),

  /** A UUID — `r.string().uuid()`. */
  uuid: (): StringRule => stringRule().uuid(),

  /** A calendar date, `2026-10-07` — `r.string().date()`. */
  date: (): StringRule => stringRule().date(),

  /** A date and time in ISO 8601 — `r.string().isoTimestamp()`. */
  isoTimestamp: (): StringRule => stringRule().isoTimestamp(),

  /**
   * A query (E55/E56): an object of fields read from the URL — strings, so `r.integer()`, `r.boolean()` and `r.in([10, 25])` take
   * their spelling — where **every field has a default** (or is optional): `parseQuery` lets an invalid field fall back to it, so
   * a URL never answers 422. The compiler names a field without one.
   *
   * ```ts
   * query: r.query({ q: r.string().trim().max(60).default(''), sort: r.in(['name', '-name']).default('name'), page: r.integer().min(1).default(1) }),
   * ```
   */
  query: <const S extends Shape>(fields: S & CheckQueryFields<S>): ObjectRule<S> => objectRule(fields as S),

  /** A port number, 1–65535. */
  port: (): Rule<number, number | `${number}`> =>
    new Rule(
      definition(() => engine.pipeEngine(numberEngine(), [engine.check((value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 65535, engine.message('port'))], false)),
    ),

  /** A comma-separated list (`ada@example.com, alan@example.com`) or a list — each item checked by `item`. */
  list: <Item extends Rule<any, any>>(item: Item): ArrayRule<InferOutput<Item>, InferInput<Item>, string | InferInput<Item>[]> =>
    new ArrayRule(
      definition((context) => engine.listEngine(item['~engine'](context), item['~rule'].async), {
        async: item['~rule'].async,
        contextual: item['~rule'].contextual,
        container: true,
      }),
    ),
};
