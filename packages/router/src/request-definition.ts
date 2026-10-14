// The one Standard Schema interface of the framework lives in @marmeon/core (types only — the router loads no code of it).
import type { InferInput, InferOutput, StandardIssue, StandardSchemaV1 } from '@marmeon/core';
import { HttpError, type TextKey } from './errors.ts';
import { issueOfFields } from './live-validation.ts';
import type { ClassResolver, EmptyObject, HttpContext } from './types.ts';

export type { InferInput, InferOutput, StandardIssue, StandardOptions, StandardResult, StandardSchemaV1 } from '@marmeon/core';

/**
 * A body schema built per request with the request's `resolve` — for another library's schema whose rules need the app (say
 * the database), or one the app's config picks: `schema: (resolve) => (resolve(RegistrationMode).private ? privately : publicly)`.
 * **A live validation never runs a schema of another library** unless the request says {@link RequestDefinition.live}.
 * `rules` of @marmeon/validation need no factory: they get `resolve` through {@link ValidationContext}.
 * See docs/validation.md#other-libraries.
 */
export type SchemaFactory<TSchema extends StandardSchemaV1> = (resolve: ClassResolver) => TSchema;

/** What an invalid query field does — never a 422: links outlive their pages, and people type URLs. */
export interface QueryOptions {
  /**
   * `'fallback'` (the default): an invalid field takes its default, an unknown one is ignored. `'redirect'`: the same,
   * and a GET with an invalid or unknown field is redirected (302) to its canonical URL — without them, so the address
   * bar shows what the page shows. Other methods always fall back.
   */
  readonly onInvalid?: 'fallback' | 'redirect';
}

/**
 * What an endpoint accepts (REPR): the schema of its body, the schema of its query and who may call it.
 * Declared next to the controller and attached with `static request = …`. Body and query never mix:
 * `schema` validates the body only — a GET has none, so a GET route takes `query` instead.
 */
export interface RequestDefinition<TSchema extends StandardSchemaV1 = any, TCtx = any, TQuery extends StandardSchemaV1 = any> {
  /** The body's schema — or a function that builds it per request, for rules that need the app (see {@link SchemaFactory}). */
  readonly schema?: TSchema | SchemaFactory<TSchema> | undefined;
  /** The query string, parsed (`ctx.query`): every field optional or with a default — an invalid one falls back to it. */
  readonly query?: TQuery | undefined;
  readonly queryOptions?: QueryOptions | undefined;
  /**
   * Runs after route binding, before validation; `false` answers 403 (or it throws its own `HttpError`).
   * Its context type is what the route must provide. `resolve` builds classes from the request's container
   * scope — how `can(Policy, …)` of @marmeon/auth gets its policy without the router knowing a container.
   */
  readonly authorize?: ((ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>) | undefined;
  /** Own messages for the framework's rules — see {@link ValidationLabels}. */
  readonly messages?: Readonly<Record<string, string>> | undefined;
  /** Names of the fields in messages (`{attribute}`) — see {@link ValidationLabels}. */
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  /**
   * `true`: a live validation runs a body schema of **another library** too (Zod, ArkType …). Fail-closed without it: such a
   * schema answers 204 live without running, because the router cannot keep its database checks out (a `refine` that asks
   * whether an address is taken would tell anyone typing one). Only for a schema none of whose checks tells more than a submit.
   */
  readonly live?: boolean | undefined;
}

/**
 * How a request's validation messages read: own texts for rules (`messages`), names for fields (`attributes`). Values are
 * translation keys or plain texts. See docs/validation.md#messages.
 *
 * ```ts
 * messages:   { 'email.unique': 'profile.validation.email_taken', required: 'Fill this in.' },   // '<field>.<rule>' or '<rule>'
 * attributes: { email: 'profile.fields.email', 'links.*.url': 'link' },                          // '*' stands for one segment
 * ```
 */
export interface ValidationLabels {
  readonly messages?: Readonly<Record<string, string>> | undefined;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
}

/**
 * What `validateRequest` hands a schema as `libraryOptions.marmeon` (Standard Schema 1.1) — what `rules` of
 * @marmeon/validation read; every other library ignores it.
 */
export interface ValidationContext {
  /** Builds classes from the request's container scope — how `unique`/`exists` get their repository. */
  readonly resolve: ClassResolver;
  /** The request, for rules that depend on it (`unique(…, { ignore: (ctx) => ctx.user.id })`). */
  readonly ctx: HttpContext;
  /** A live validation: rules that ask something outside the value (the database) do not run, unless they say `.live()`. */
  readonly live: boolean;
}

/** What a query value may become: what the URL can carry back (`String()` of it — see `toSearchParams`). */
type QueryScalar = string | number | boolean;
type QueryFieldValue = QueryScalar | readonly QueryScalar[] | undefined;

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Quoted<K> = `'${K & string}'`;
type JoinKeys<K> = [K] extends [never] ? '' : Quoted<K>; // one name is enough to point at the problem

/** Fields whose input is no string: the URL only ever has strings (`unknown` — a coercing schema — is fine). */
type NonStringFields<I> = {
  [K in keyof I]-?: unknown extends I[K] ? never : [Extract<Exclude<I[K], undefined>, string | readonly string[]>] extends [never] ? K : never;
}[keyof I];

/** Fields whose output cannot go back into a URL (a Date, an object). */
type UnserializableFields<O> = { [K in keyof O]-?: O[K] extends QueryFieldValue ? never : K }[keyof O];

type First<U> = (U extends unknown ? (x: () => U) => void : never) extends (x: infer I) => void ? (I extends () => infer R ? R : never) : never;

/**
 * `TQuery` when it describes a query; otherwise the message the compiler shows as the expected type:
 * - total: an empty query must be valid, so each field can fall back — never a 422;
 * - string input: the URL has strings, so a number is parsed (`r.integer()` of @marmeon/validation takes its spelling);
 * - serializable output: what a link puts back into the URL (`String()`) must parse to the same value.
 */
export type CheckQuery<TQuery extends StandardSchemaV1> =
  InferOutput<TQuery> extends Record<string, unknown>
    ? InferInput<TQuery> extends Record<string, unknown>
      ? [RequiredKeys<InferInput<TQuery>>] extends [never]
        ? [NonStringFields<InferInput<TQuery>>] extends [never]
          ? [UnserializableFields<InferOutput<TQuery>>] extends [never]
            ? TQuery
            : `query field ${JoinKeys<First<UnserializableFields<InferOutput<TQuery>>>>} cannot go back into a URL — a query value is a string, number, boolean or an array of them`
          : `query fields are read from the URL as strings: ${JoinKeys<First<NonStringFields<InferInput<TQuery>>>>} does not take one — parse the string, e.g. r.integer() or r.in([…]) in r.query({ … })`
        : `query fields need a default or must be optional: ${JoinKeys<First<RequiredKeys<InferInput<TQuery>>>>} is required`
      : 'a query schema describes an object of fields — r.query({ … })'
    : 'a query schema describes an object of fields — r.query({ … })';

/**
 * Declares what an endpoint accepts ({@link RequestDefinition}); a controller attaches it with `static request = …` and its
 * `handle` takes `ContextOf<typeof …>`: `ctx.body` is the schema's output, `ctx.query` the parsed query (an invalid field falls
 * back to its default). See docs/requests.md#validated-input and docs/requests.md#query-schemas.
 */
export function defineRequest<TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TCtx = HttpContext>(definition: {
  schema?: TSchema | SchemaFactory<TSchema>;
  query?: CheckQuery<TQuery>;
  queryOptions?: QueryOptions;
  authorize?: (ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>;
  /** Own messages for the framework's rules: `{ 'email.unique': 'profile.validation.email_taken' }` ({@link ValidationLabels}). */
  messages?: Readonly<Record<string, string>>;
  /** Names of the fields in messages: `{ email: 'profile.fields.email' }` ({@link ValidationLabels}). */
  attributes?: Readonly<Record<string, string>>;
  /** A schema of another library runs in a live validation too — see {@link RequestDefinition.live}. */
  live?: boolean;
}): RequestDefinition<TSchema, TCtx, TQuery> {
  return definition as RequestDefinition<TSchema, TCtx, TQuery>;
}

/** Type-only marker: carries the request in a handler's context, so `FormOf<Controller>` can find it. */
declare const REQUEST: unique symbol;

/** The body schema of a request — what its {@link SchemaFactory} builds, when it has one — `never` without one. */
export type SchemaOf<R> = R extends { readonly schema?: infer S }
  ? S extends StandardSchemaV1
    ? S
    : S extends (resolve: never) => infer Built
      ? Built extends StandardSchemaV1
        ? Built
        : never
      : never
  : never;

/** The query schema of a request — `never` without one. */
export type QuerySchemaOf<R> = R extends { readonly query?: infer Q } ? (Q extends StandardSchemaV1 ? Q : never) : never;

/** What validation adds to the context — like a middleware's `next({ body })`. (The parsed query: {@link ContextOf}.) */
export type Validated<R extends RequestDefinition> = BodyOf<SchemaOf<R>> & {
  readonly [REQUEST]?: R;
};

/** `ctx` with the parsed query in place of the raw `URLSearchParams` — when there is a query schema. */
export type WithQuery<TCtx, TQuery extends StandardSchemaV1> = [TQuery] extends [never]
  ? TCtx
  : Omit<TCtx, 'query'> & { readonly query: InferOutput<TQuery> };

/** The full context of an endpoint: what its `authorize` needs, plus the validated body and the parsed query. */
export type ContextOf<R extends RequestDefinition> =
  R extends RequestDefinition<StandardSchemaV1, infer TCtx> ? WithQuery<TCtx, QuerySchemaOf<R>> & Validated<R> : never;

/** The request a controller's `handle` accepts (via `ContextOf` / `Validated`), or `never`. */
export type RequestOf<C> = C extends { handle: (ctx: infer TCtx, ...rest: any[]) => unknown }
  ? TCtx extends { readonly [REQUEST]?: infer R extends RequestDefinition }
    ? R
    : never
  : never;

/** The form a controller accepts — its schema's *input* type (what the browser sends). */
export type FormOf<C> = InferInput<SchemaOf<RequestOf<C>>>;

/** The parsed query of a controller (`ctx.query`, defaults filled in) — `never` without a query schema. */
export type QueryOf<C> = [QuerySchemaOf<RequestOf<C>>] extends [never] ? never : InferOutput<QuerySchemaOf<RequestOf<C>>>;

/** A route's controller either has no request (`never`) or adds a validated body to the context. */
export type BodyOf<TSchema extends StandardSchemaV1> = [TSchema] extends [never]
  ? EmptyObject
  : { readonly body: InferOutput<TSchema> };

/** Field errors: `{ name: ['Invalid length: …'], 'address.city': [...] }`. */
export type ValidationErrors = Record<string, string[]>;

/**
 * What {@link ValidationError.translate} needs of a translator — the `Translator` contract of @marmeon/core
 * (the router depends on no package, so it is spelled out here).
 */
export interface MessageTranslator {
  has(key: string): boolean;
  text(key: string, params?: Readonly<Record<string, unknown>>, fallback?: string): string;
}

/** Where {@link translatable} leaves its key on an issue (a symbol: never serialized, never shown). */
const TRANSLATION = Symbol.for('marmeon.translation');

/** What {@link translatable} leaves on an issue: its key, its parameters and the text without a translator. */
interface Translation extends TextKey {
  readonly fallback?: string | undefined;
}

/**
 * On an issue of a rule that does not run in a live validation (`unique`, `exists`, async rules without `.live()`): a live
 * validation drops it even when the rule ran — the schema was called without the request's {@link ValidationContext}, say
 * inside another library's schema. Set by @marmeon/validation; a symbol: never serialized, never shown.
 */
export const NOT_LIVE = Symbol.for('marmeon.validation.notLive');

/**
 * A validation message by translation key, as a message function for schemas:
 * `r.string().custom(isSlug, translatable('teams.validation.slug', {}, 'Letters and dashes only.'))`. The request's translator
 * shows it in the request's language; without one, the issue keeps `fallback` (or the key). Apps use the typed `trans()` of
 * @marmeon/i18n. See docs/validation.md#messages.
 */
export function translatable(key: string, params?: Readonly<Record<string, unknown>>, fallback?: string): (issue: object) => string {
  return (issue) => {
    try {
      Object.defineProperty(issue, TRANSLATION, { value: { key, params, fallback } satisfies Translation, configurable: true });
    } catch {
      // A frozen issue keeps the fallback.
    }
    return fill(fallback ?? key, params);
  };
}

function fill(text: string, params: Readonly<Record<string, unknown>> = {}): string {
  return text.replace(/\{([\w-]+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

/** The values a message may show of an issue — what was required (`min_length` → 2), never the input (a password). */
function issueParams(issue: StandardIssue): Record<string, unknown> {
  const { requirement, expected } = issue as { requirement?: unknown; expected?: unknown };
  const params: Record<string, unknown> = {};
  if (typeof requirement === 'number' || typeof requirement === 'string' || typeof requirement === 'bigint') params.requirement = requirement;
  if (typeof expected === 'string') params.expected = expected;
  return params;
}

/**
 * A field as messages name it (`{attribute}`): its path with underscores as spaces — `password_confirmation` →
 * "password confirmation", `links.0.url` → "links.0.url". (An issue without a path — a schema of one value — names it "value".)
 */
export function attributeName(field: string): string {
  return field.replaceAll('_', ' ');
}

/** The value of `field` in labels keyed by field (`links.*.url`: `*` stands for one segment). */
function labelOf(labels: Readonly<Record<string, string>> | undefined, field: string): string | undefined {
  if (!labels) return undefined;
  if (Object.hasOwn(labels, field)) return labels[field];
  const segments = field.split('.');
  for (const [pattern, label] of Object.entries(labels)) {
    if (!pattern.includes('*')) continue;
    const parts = pattern.split('.');
    if (parts.length === segments.length && parts.every((part, index) => part === '*' || part === segments[index])) return label;
  }
  return undefined;
}

/** The framework rule a key belongs to: `max` for `marmeon.validation.max.string`. */
function ruleOf(key: string): string | undefined {
  return key.startsWith('marmeon.validation.') ? key.split('.')[2] : undefined;
}

export interface MessageOptions {
  /** The request's translator: the message in its language. Without one, the English text. */
  readonly translator?: MessageTranslator | undefined;
  readonly labels?: ValidationLabels | undefined;
}

/**
 * The text of an issue: a key {@link translatable} left in the translator's language (or its English fallback), with `{attribute}`
 * — the field's name ({@link ValidationLabels.attributes}, else {@link attributeName}) — and what the issue required; the
 * request's own message for the rule, when it has one; a message that is a known key, translated. Other messages stay.
 */
export function messageOf(issue: StandardIssue, { translator, labels }: MessageOptions = {}): string {
  const translation = (issue as { [TRANSLATION]?: Translation })[TRANSLATION];
  if (!translation) return translator?.has(issue.message) ? translator.text(issue.message, issueParams(issue)) : issue.message;
  const field = fieldOf(issue);
  const label = labelOf(labels?.attributes, field);
  const attribute =
    label !== undefined ? (translator?.has(label) ? translator.text(label) : label) : (translation.params?.attribute ?? (field === '_' ? 'value' : attributeName(field)));
  const params = { ...issueParams(issue), ...translation.params, attribute };
  const rule = ruleOf(translation.key);
  const own = rule === undefined ? undefined : (labelOf(labels?.messages, `${field}.${rule}`) ?? (Object.hasOwn(labels?.messages ?? {}, rule) ? labels!.messages![rule] : undefined));
  if (own !== undefined) return translator?.has(own) ? translator.text(own, params) : fill(own, params);
  if (translator) return translator.text(translation.key, params, translation.fallback ?? issue.message);
  return translation.fallback === undefined ? issue.message : fill(translation.fallback, params);
}

function fieldOf(issue: StandardIssue): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.') || '_';
}

/**
 * Invalid input (422). The exception handler answers APIs with `{ message, errors }`
 * and sends pages back with the errors and the old input in the session.
 */
export class ValidationError extends HttpError {
  override name = 'ValidationError';
  readonly errors: ValidationErrors;
  /** The input that failed, for `old()`. */
  readonly input: Record<string, unknown>;
  /** The schema's issues, when the errors come from validation — what {@link translate} translates. */
  readonly issues: readonly StandardIssue[] | undefined;
  /** The request's own messages and field names, for {@link translate}. */
  readonly labels: ValidationLabels | undefined;

  /** Messages may be translation keys (`auth.login.failed`): {@link translate} turns known ones into text. */
  constructor(errors: ValidationErrors, input: Record<string, unknown> = {}, issues?: readonly StandardIssue[], labels?: ValidationLabels) {
    const messages = Object.values(errors).flat();
    const more = messages.length - 1;
    super(422, more > 0 ? `${messages[0]} (and ${more} more error${more === 1 ? '' : 's'})` : (messages[0] ?? 'The given data was invalid.'));
    this.errors = errors;
    this.input = input;
    this.issues = issues;
    this.labels = labels;
  }

  /** The errors of a schema's issues, by field — in English ({@link translate} for the request's language). */
  static fromIssues(issues: readonly StandardIssue[], input: Record<string, unknown>, labels?: ValidationLabels): ValidationError {
    const errors: ValidationErrors = {};
    for (const issue of issues) (errors[fieldOf(issue)] ??= []).push(messageOf(issue, { labels }));
    return new ValidationError(errors, input, issues, labels);
  }

  /**
   * The same errors in the translator's language — what the exception handler shows (the request's translator):
   * keys left by {@link translatable} (with what the issue required, e.g. `{requirement}`), and messages that are
   * keys themselves. Other messages stay as they are.
   */
  translate(translator: MessageTranslator): ValidationError {
    const errors: ValidationErrors = {};
    if (this.issues) {
      for (const issue of this.issues) (errors[fieldOf(issue)] ??= []).push(messageOf(issue, { translator, labels: this.labels }));
    } else {
      for (const [field, messages] of Object.entries(this.errors)) {
        errors[field] = messages.map((message) => (translator.has(message) ? translator.text(message) : message));
      }
    }
    const translated = new ValidationError(errors, this.input, this.issues, this.labels);
    const messages = Object.values(errors).flat();
    if (messages.length > 1) {
      const count = messages.length - 1;
      translated.message = `${messages[0]} ${translator.text('marmeon.validation.more', { count }, `(and ${count} more error${count === 1 ? '' : 's'})`)}`;
    }
    return translated;
  }
}

/** What {@link validateRequest} hands the controller. */
export interface ValidatedRequest {
  /** The validated body — only when the request has a `schema` (and this is no live validation: see `only`). */
  readonly body?: unknown;
  /** The parsed query — only when the request has a `query` schema. */
  readonly query?: ParsedQuery;
}

/**
 * Runs before a body schema validates the input (`router.beforeValidation(hook)`) — after `authorize`, for a submit and a live
 * validation alike. A hook may replace values of `input` with what the schema expects instead: @marmeon/storage puts the
 * verified upload in place of an upload token, which needs the request (its session) that a schema never sees.
 */
export type ValidationHook = (input: Record<string, unknown>, context: ValidationHookContext) => void | Promise<void>;

export interface ValidationHookContext {
  readonly ctx: HttpContext;
  /** The body schema about to run (built by its factory, when it has one). */
  readonly schema: StandardSchemaV1;
  readonly resolve: ClassResolver;
}

/** How {@link validateRequest} runs. */
export interface ValidateOptions {
  /**
   * A live validation: check these fields only — the body's issues outside them are dropped, and a valid result has no
   * body (the controller does not run). A request without a body schema has nothing to check: 400.
   */
  readonly only?: readonly string[] | undefined;
  /** What runs before the body schema (see {@link ValidationHook}). */
  readonly hooks?: readonly ValidationHook[] | undefined;
}

/** The 403 every refused check answers with, so a route's registrar and its request look the same from outside. */
export function unauthorized(): HttpError {
  return new HttpError(403, 'This action is unauthorized.', {}, { key: 'marmeon.errors.unauthorized' });
}

/** The request's `authorize` — a 403 when it says no. (What {@link validateRequest} runs first.) */
export async function authorizeRequest(definition: RequestDefinition, ctx: HttpContext, resolve: ClassResolver = (Class) => new Class()): Promise<void> {
  // Only `true` lets a request on: a policy response, a Result or any other truthy value is a refusal.
  if (definition.authorize && (await definition.authorize(ctx, resolve)) !== true) {
    throw unauthorized();
  }
}

/**
 * Runs a request definition: authorize (403), then parse the query (never fails — invalid fields fall back), then
 * validate the body (422). Body and query never mix: `schema` sees `ctx.input()`, which is the body alone.
 */
export async function validateRequest(
  definition: RequestDefinition,
  ctx: HttpContext,
  resolve: ClassResolver = (Class) => new Class(),
  { only, hooks = [] }: ValidateOptions = {},
): Promise<ValidatedRequest> {
  await authorizeRequest(definition, ctx, resolve);
  const query = definition.query ? await parseQuery(definition.query, ctx.query) : undefined;
  if (!definition.schema) {
    if (only) throw nothingToValidate();
    return query ? { query } : {};
  }
  const schema: StandardSchemaV1 = typeof definition.schema === 'function' ? definition.schema(resolve) : definition.schema;
  // A live validation runs `rules` (which keep their database checks out), another library's schema only when the request
  // opts in. Fail-closed: the router cannot see which of its checks ask the database, so it answers as for a valid field.
  if (only && !definition.live && !runsLive(schema)) return query ? { query } : {};
  const input = await ctx.input();
  for (const hook of hooks) await hook(input, { ctx, schema, resolve });
  const context: ValidationContext = { resolve, ctx, live: only !== undefined };
  const result = await schema['~standard'].validate(input, { libraryOptions: { marmeon: context } });
  const labels: ValidationLabels = { messages: definition.messages, attributes: definition.attributes };
  if (only) {
    // The named fields' issues only — the others are not filled in yet (or never sent: passwords). No input goes back. And
    // never what a rule that is not live found, should it have run: free and taken values get the same answer.
    const issues = (result.issues ?? []).filter((issue) => issueOfFields(issue, only) && !(issue as { [NOT_LIVE]?: boolean })[NOT_LIVE]);
    if (issues.length > 0) throw ValidationError.fromIssues(issues, {}, labels);
    return query ? { query } : {};
  }
  if (result.issues) throw ValidationError.fromIssues(result.issues, input, labels);
  return query ? { body: result.value, query } : { body: result.value };
}

/** The vendor of @marmeon/validation's rules — the only schemas a live validation runs without the request's `live: true`. */
const LIVE_VENDOR = 'marmeon';

/** Whether a live validation runs `schema` by itself: `rules` of @marmeon/validation, which decide per rule. */
function runsLive(schema: StandardSchemaV1): boolean {
  return schema['~standard'].vendor === LIVE_VENDOR;
}

/** A live validation of a route that validates no body (no `schema`, a GET, a closure): a mistake of the client. */
export function nothingToValidate(): HttpError {
  return new HttpError(400, 'A live validation needs a route with a request schema: this route validates no body.');
}

/** A query, parsed against its schema. */
export interface ParsedQuery {
  /** The parsed query, defaults filled in — `ctx.query`. */
  readonly value: Record<string, unknown>;
  /**
   * The fields the URL set — valid, parsed, and not just the default: what the page object carries (`PageObject.query`)
   * and what the canonical URL has.
   */
  readonly canonical: Record<string, unknown>;
  /** What an empty query parses to — the defaults (the browser leaves them out of URLs it builds). */
  readonly defaults: Record<string, unknown>;
  /** Keys of the URL that were left out: invalid (they fell back to their default) or unknown. */
  readonly dropped: readonly string[];
}

/**
 * The query as a schema's input: a key once is a string, a key repeated (`?tag=a&tag=b`) a list of them — what
 * `toSearchParams` writes for a list. (`__proto__` is not a key.)
 */
export function queryInput(search: URLSearchParams): Record<string, string | string[]> {
  const input: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of search) {
    if (key === '__proto__') continue;
    const seen = input[key];
    input[key] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return input;
}

/**
 * Parses a query against its schema and never fails for what the URL holds: a field the schema rejects falls back to its
 * default, found by the issues' paths so any Standard Schema library works. See docs/requests.md#how-a-query-is-parsed.
 *
 * Throws only for a schema that is not total — one an empty query fails (the types refuse it: `CheckQuery`).
 */
export async function parseQuery(schema: StandardSchemaV1, search: URLSearchParams): Promise<ParsedQuery> {
  const validate = async (value: unknown) => schema['~standard'].validate(value);
  const empty = await validate({});
  if (empty.issues) throw notTotal(empty.issues);
  const defaults = asRecord(empty.value);

  const input: Record<string, unknown> = queryInput(search);
  const keys = Object.keys(input);
  const dropped = new Set<string>();
  const asList = new Set<string>();
  let value = defaults;
  for (let attempt = 0; attempt <= keys.length * 2; attempt++) {
    const result = await validate({ ...input });
    if (!result.issues) {
      value = asRecord(result.value);
      break;
    }
    const failing = [...new Set(result.issues.map(topKey))].filter((key): key is string => key !== undefined && Object.hasOwn(input, key));
    // An issue no key of the URL can be blamed for (a check over the whole object): nothing of the URL counts.
    for (const key of failing.length > 0 ? failing : Object.keys(input)) {
      if (typeof input[key] === 'string' && !asList.has(key)) {
        asList.add(key);
        input[key] = [input[key]];
      } else {
        delete input[key];
        dropped.add(key);
      }
    }
    if (Object.keys(input).length === 0) break; // the empty query is valid: `value` stays the defaults
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(value, key)) dropped.add(key); // unknown to the schema
    else if (!sameValue(value[key], defaults[key])) canonical[key] = value[key];
  }
  return { value, canonical, defaults, dropped: [...dropped] };
}

function topKey(issue: StandardIssue): string | undefined {
  const first = issue.path?.[0];
  if (first === undefined) return undefined;
  return String(typeof first === 'object' ? first.key : first);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Query values are JSON values (strings, numbers, booleans, lists of them). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function notTotal(issues: readonly StandardIssue[]): Error {
  const fields = [...new Set(issues.map(topKey).filter((key) => key !== undefined))];
  return new Error(
    `A query schema must accept an empty query — every field needs a default or must be optional${fields.length > 0 ? ` (${fields.map((f) => `'${f}'`).join(', ')} ${fields.length === 1 ? 'is' : 'are'} required)` : ''}: an invalid field falls back to its default, a URL never answers 422.`,
  );
}
