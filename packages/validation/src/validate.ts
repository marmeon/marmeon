import { err, ok, type InferOutput, type Result, type StandardSchemaV1 } from '@marmeon/core';
import { ValidationError, type MessageTranslator, type ValidationContext, type ValidationErrors, type ValidationLabels } from '@marmeon/router';

/** What {@link validate} takes besides the value: a request's `messages` and `attributes`, `resolve` and a translator. */
export interface ValidateOptions extends ValidationLabels {
  /** Builds the repositories of `unique`/`exists` (`(Class) => container.make(Class)`). Without it, such a rule throws. */
  readonly resolve?: ValidationContext['resolve'] | undefined;
  /** The language of the messages — a `Translator` of `@marmeon/core`. Without one, the English texts. */
  readonly translator?: MessageTranslator | undefined;
}

/** The error of {@link validate}: the messages of the value by field — `_` for the value as a whole. */
export interface InvalidValue {
  readonly kind: 'invalid';
  readonly errors: ValidationErrors;
}

/**
 * The `ctx` of a validation without a request. It is truthy and every read of it throws, so a `where` that falls back
 * (`ctx ? q.where('team_id', '=', ctx.user.team_id) : q`) fails closed instead of dropping its filter. Symbols and `then`
 * answer `undefined`, so inspecting or awaiting it triggers nothing.
 */
const NO_REQUEST: object = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`r.…exists()/unique() reads ctx in where/ignore (or custom() reads request.ctx) — validate() has no request, so it has no ctx.${key}.`);
    },
  },
);

/**
 * Checks a value against a schema outside a request — a row of an import, a job's payload, a command's argument — with the
 * rules and messages of a form. An invalid value is an `err` with the messages by field; `unique` and `exists` need `resolve`.
 * A rule that reads the request (`ctx` in `where`/`ignore`) throws, since there is none. See docs/validation.md#outside-a-request.
 */
export async function validate<TSchema extends StandardSchemaV1>(schema: TSchema, value: unknown, options: ValidateOptions = {}): Promise<Result<InferOutput<TSchema>, InvalidValue>> {
  const { resolve, translator, messages, attributes } = options;
  const context = resolve && ({ resolve, ctx: NO_REQUEST, live: false } as unknown as ValidationContext);
  const result = await schema['~standard'].validate(value, context ? { libraryOptions: { marmeon: context } } : undefined);
  if (!result.issues) return ok(result.value as InferOutput<TSchema>);
  const failure = ValidationError.fromIssues(result.issues, {}, { messages, attributes });
  return err({ kind: 'invalid', errors: (translator ? failure.translate(translator) : failure).errors } as const);
}
