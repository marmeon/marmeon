/**
 * The Standard Schema interface (https://standardschema.dev), copied as the spec recommends so core depends on no
 * validation library — the one copy of the framework (the router takes it from here). Every schema the framework
 * accepts is one: the env reader of this package (`env`), `rules` of @marmeon/validation (what docs and generators use, E197),
 * and Zod, Valibot, ArkType …
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
 * Spec 1.1: options of one validation — `libraryOptions` are the library's own (not all libraries read them). The router
 * passes `{ marmeon: … }` there: what `rules` of @marmeon/validation need of the request (its `resolve`, whether it is a
 * live validation); any other library ignores it.
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

/** What a schema takes — what the browser sends for a form (`FormOf`). */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
/** What a schema gives back once valid — `ctx.body`, `ctx.query`, a config's `env`. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];

/** `APP_URL` or `database.host` — the path of an issue, for messages. */
export function issuePath(issue: StandardIssue): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
}
