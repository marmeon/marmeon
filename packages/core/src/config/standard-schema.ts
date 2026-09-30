/**
 * The Standard Schema interface (https://standardschema.dev), copied as the spec
 * recommends so core depends on no validation library. Valibot, Zod, ArkType and
 * others implement it; Valibot is the default in docs and generators (E5).
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

export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];

/** `APP_URL` or `database.host` — the path of an issue, for messages. */
export function issuePath(issue: StandardIssue): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
}
