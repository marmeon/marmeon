const CONFLICT_RESULT = Symbol.for('marmeon.conflict-result');

/**
 * What `conflict(current)` returns: the answer to a save that went stale — someone else changed the record first. An
 * action (`useAction` of @marmeon/react) ends `{ kind: 'conflict', current, message }`, with `current` as `Serialize<T>`; an
 * API client gets `409` with the same JSON. Not a {@link JsonResult}, and without `headers`: nothing can add a location to
 * it, which would make the `409` a document change. See docs/actions.md#the-result.
 */
export interface ConflictResult<T = unknown> {
  readonly [CONFLICT_RESULT]: true;
  /** The marker the action types read: this branch of a controller answers with a conflict. */
  readonly kind: 'conflict';
  /** The current state of the record, as the save should have seen it. */
  readonly current: T;
  /** A text, or a key of the app's language files; without one the framework's own is sent. */
  readonly message?: string;
}

/**
 * `current` as the answer to a stale save: `return conflict(current)`. `useAction` ends `{ kind: 'conflict', current, message }`,
 * an API client gets `409` with `{ message, current }`. Without `options.message` the text is `marmeon.errors.conflict`, in the
 * request's language; `message` is a text or a key of your language files. Return it from the controller, do not throw it.
 * Throws a `TypeError` for options that are not an object, an unknown option or a message that is no string.
 * See docs/responses.md#conflict.
 */
export function conflict<T>(current: T, options: { message?: string } = {}): ConflictResult<T> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError("conflict(): the second argument is an object, { message: 'notes.stale' }");
  for (const key of Object.keys(options)) {
    if (key !== 'message') throw new TypeError(`conflict(): unknown option '${key}' — the only option is { message }`);
  }
  const { message } = options;
  if (message !== undefined && typeof message !== 'string') throw new TypeError('conflict(): message is a text or a key of your language files');
  return { [CONFLICT_RESULT]: true, kind: 'conflict', current, ...(message !== undefined ? { message } : {}) };
}

export function isConflictResult(value: unknown): value is ConflictResult {
  return typeof value === 'object' && value !== null && CONFLICT_RESULT in value;
}
