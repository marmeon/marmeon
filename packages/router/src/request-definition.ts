import { HttpError } from './errors.ts';
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
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
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
 * Invalid input (422). The exception handler answers APIs with `{ message, errors }`
 * and sends pages back with the errors and the old input in the session.
 */
export class ValidationError extends HttpError {
  override name = 'ValidationError';
  readonly errors: ValidationErrors;
  /** The input that failed, for `old()`. */
  readonly input: Record<string, unknown>;

  constructor(errors: ValidationErrors, input: Record<string, unknown> = {}) {
    const messages = Object.values(errors).flat();
    const more = messages.length - 1;
    super(422, more > 0 ? `${messages[0]} (and ${more} more error${more === 1 ? '' : 's'})` : (messages[0] ?? 'The given data was invalid.'));
    this.errors = errors;
    this.input = input;
  }

  static fromIssues(issues: readonly StandardIssue[], input: Record<string, unknown>): ValidationError {
    const errors: ValidationErrors = {};
    for (const issue of issues) {
      const field = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.') || '_';
      (errors[field] ??= []).push(issue.message);
    }
    return new ValidationError(errors, input);
  }
}

/** Runs a request definition: authorize (403), then validate (422). Returns the validated body. */
export async function validateRequest(definition: RequestDefinition, ctx: HttpContext, resolve: ClassResolver = (Class) => new Class()): Promise<unknown> {
  if (definition.authorize && !(await definition.authorize(ctx, resolve))) {
    throw new HttpError(403, 'This action is unauthorized.');
  }
  const input = await ctx.input();
  const result = await definition.schema['~standard'].validate(input);
  if (result.issues) throw ValidationError.fromIssues(result.issues, input);
  return result.value;
}
