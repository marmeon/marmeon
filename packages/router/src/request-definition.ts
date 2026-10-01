import { HttpError, type TextKey } from './errors.ts';
import type { ClassResolver, EmptyObject, HttpContext } from './types.ts';

/**
 * The Standard Schema interface (https://standardschema.dev), copied as the spec
 * recommends — the router depends on no validation library. Valibot, Zod, ArkType
 * and others implement it; Valibot is the default in docs and generators (E5).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown, options?: StandardOptions | undefined) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/**
 * Spec 1.1: options of one validation. `libraryOptions` are the library's own — Valibot 1.5 ignores them (its
 * `~standard.validate` reads only the global config), so the request's language does not travel this way:
 * messages are translated afterwards, per request ({@link ValidationError.translate}).
 */
export interface StandardOptions {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];

/**
 * What an endpoint accepts (REPR): the schema of its input and who may call it.
 * Declared next to the controller and attached with `static request = …` (E13).
 */
export interface RequestDefinition<TSchema extends StandardSchemaV1 = StandardSchemaV1, TCtx = any> {
  readonly schema: TSchema;
  /**
   * Runs after route binding, before validation; `false` answers 403 (or it throws its own `HttpError`).
   * Its context type is what the route must provide. `resolve` builds classes from the request's container
   * scope — how `can(Policy, …)` of @bespokecore/auth gets its policy without the router knowing a container (E28).
   */
  readonly authorize?: ((ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>) | undefined;
}

/**
 * ```ts
 * export const UpdateUserProfileRequest = defineRequest({
 *   schema: v.object({ name: v.pipe(v.string(), v.minLength(2)) }),
 *   authorize: (ctx: HttpContext<AuthState, { id: string }>) => ctx.user.id === ctx.params.id,
 * });
 *
 * export class UpdateUserProfileController extends Controller {
 *   static request = UpdateUserProfileRequest;
 *   handle(ctx: ContextOf<typeof UpdateUserProfileRequest>) { ctx.body.name; }
 * }
 * ```
 */
export function defineRequest<TSchema extends StandardSchemaV1, TCtx = HttpContext>(definition: {
  schema: TSchema;
  authorize?: (ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>;
}): RequestDefinition<TSchema, TCtx> {
  return definition;
}

/** Type-only marker: carries the request in a handler's context, so `FormOf<Controller>` can find it. */
declare const REQUEST: unique symbol;

/** What validation adds to the context — like a middleware's `next({ body })`. */
export type Validated<R extends RequestDefinition> = {
  readonly body: InferOutput<R['schema']>;
  readonly [REQUEST]?: R;
};

/** The full context of an endpoint: what its `authorize` needs, plus the validated body. */
export type ContextOf<R extends RequestDefinition> =
  R extends RequestDefinition<StandardSchemaV1, infer TCtx> ? TCtx & Validated<R> : never;

/** The request a controller's `handle` accepts (via `ContextOf` / `Validated`), or `never`. */
export type RequestOf<C> = C extends { handle: (ctx: infer TCtx, ...rest: any[]) => unknown }
  ? TCtx extends { readonly [REQUEST]?: infer R extends RequestDefinition }
    ? R
    : never
  : never;

/** The form a controller accepts — its schema's *input* type (what the browser sends). */
export type FormOf<C> = InferInput<RequestOf<C>['schema']>;

/** A route's controller either has no request (`never`) or adds a validated body to the context. */
export type BodyOf<TSchema extends StandardSchemaV1> = [TSchema] extends [never]
  ? EmptyObject
  : { readonly body: InferOutput<TSchema> };

/** Field errors: `{ name: ['Invalid length: …'], 'address.city': [...] }`. */
export type ValidationErrors = Record<string, string[]>;

/**
 * What {@link ValidationError.translate} needs of a translator — the `Translator` contract of @bespokecore/core
 * (the router depends on no package, so it is spelled out here).
 */
export interface MessageTranslator {
  has(key: string): boolean;
  text(key: string, params?: Readonly<Record<string, unknown>>, fallback?: string): string;
}

/** Where {@link translatable} leaves its key on an issue (a symbol: never serialized, never shown). */
const TRANSLATION = Symbol.for('bespokecore.translation');

/**
 * A validation message by translation key, for schemas — a message function as Valibot (and Zod) accept them:
 * `v.minLength(2, translatable('auth.validation.name_min', { min: 2 }, 'At least 2 characters.'))`. It leaves the
 * key on the issue, and the request's translator turns it into the request's language
 * ({@link ValidationError.translate}); without a translator, the issue keeps `fallback` (or the key).
 *
 * Apps use the typed `trans()` of @bespokecore/i18n. A plain string that is a known key works too, with any library.
 */
export function translatable(key: string, params?: Readonly<Record<string, unknown>>, fallback?: string): (issue: object) => string {
  return (issue) => {
    try {
      Object.defineProperty(issue, TRANSLATION, { value: { key, params } satisfies TextKey, configurable: true });
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

function issueMessage(issue: StandardIssue, translator: MessageTranslator): string {
  const translation = (issue as { [TRANSLATION]?: TextKey })[TRANSLATION];
  if (translation) return translator.text(translation.key, { ...issueParams(issue), ...translation.params }, issue.message);
  return translator.has(issue.message) ? translator.text(issue.message, issueParams(issue)) : issue.message;
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

  /** Messages may be translation keys (`auth.login.failed`): {@link translate} turns known ones into text. */
  constructor(errors: ValidationErrors, input: Record<string, unknown> = {}, issues?: readonly StandardIssue[]) {
    const messages = Object.values(errors).flat();
    const more = messages.length - 1;
    super(422, more > 0 ? `${messages[0]} (and ${more} more error${more === 1 ? '' : 's'})` : (messages[0] ?? 'The given data was invalid.'));
    this.errors = errors;
    this.input = input;
    this.issues = issues;
  }

  static fromIssues(issues: readonly StandardIssue[], input: Record<string, unknown>): ValidationError {
    const errors: ValidationErrors = {};
    for (const issue of issues) (errors[fieldOf(issue)] ??= []).push(issue.message);
    return new ValidationError(errors, input, issues);
  }

  /**
   * The same errors in the translator's language — what the exception handler shows (the request's translator):
   * keys left by {@link translatable} (with what the issue required, e.g. `{requirement}`), and messages that are
   * keys themselves. Other messages stay as they are.
   */
  translate(translator: MessageTranslator): ValidationError {
    const errors: ValidationErrors = {};
    if (this.issues) {
      for (const issue of this.issues) (errors[fieldOf(issue)] ??= []).push(issueMessage(issue, translator));
    } else {
      for (const [field, messages] of Object.entries(this.errors)) {
        errors[field] = messages.map((message) => (translator.has(message) ? translator.text(message) : message));
      }
    }
    const translated = new ValidationError(errors, this.input, this.issues);
    const messages = Object.values(errors).flat();
    if (messages.length > 1) {
      const count = messages.length - 1;
      translated.message = `${messages[0]} ${translator.text('bespoke.validation.more', { count }, `(and ${count} more error${count === 1 ? '' : 's'})`)}`;
    }
    return translated;
  }
}

/** Runs a request definition: authorize (403), then validate (422). Returns the validated body. */
export async function validateRequest(definition: RequestDefinition, ctx: HttpContext, resolve: ClassResolver = (Class) => new Class()): Promise<unknown> {
  if (definition.authorize && !(await definition.authorize(ctx, resolve))) {
    throw new HttpError(403, 'This action is unauthorized.', {}, { key: 'bespoke.errors.unauthorized' });
  }
  const input = await ctx.input();
  const result = await definition.schema['~standard'].validate(input);
  if (result.issues) throw ValidationError.fromIssues(result.issues, input);
  return result.value;
}
