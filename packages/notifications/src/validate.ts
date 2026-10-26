import type { StandardIssue as Issue, StandardSchemaV1 } from '@marmeon/core';

/**
 * The fields of issues as one line, without the values their text quotes — for data that is encrypted in the queue.
 * A key of a record is data too: only what looks like a declared field name stays.
 */
export function describeFields(issues: readonly Issue[]): string {
  const segment = (key: unknown) => (typeof key === 'number' ? String(key) : /^[A-Za-z_$][\w$]{0,31}$/.test(String(key)) ? String(key) : '*');
  const paths = [...new Set(issues.map((issue) => (issue.path ?? []).map((part) => segment(typeof part === 'object' ? part.key : part)).join('.') || '(root)'))];
  return paths.join(', ');
}

/** A notification's data does not match its schema (when it is sent, or — after a deploy — when it is delivered). */
export class NotificationDataError extends Error {
  override name = 'NotificationDataError';
  declare readonly issues: readonly Issue[];

  constructor(message: string, issues: readonly Issue[] = []) {
    super(message);
    // Not enumerable: `describeError` writes an error's own properties into `failed_jobs`, and an issue carries the value it rejected.
    Object.defineProperty(this, 'issues', { value: issues, enumerable: false });
  }
}

/** Validates against a schema — its output, or a {@link NotificationDataError} saying `what`. */
export async function validate(schema: StandardSchemaV1, value: unknown, what: string): Promise<unknown> {
  const result = await schema['~standard'].validate(value);
  // The data is encrypted in the queue: the message names the fields, the issues (with the values) stay on `.issues`.
  if (result.issues) throw new NotificationDataError(`${what} (fields: ${describeFields(result.issues)}).`, result.issues);
  return result.value;
}

/** The value as JSON makes it (what the queue keeps) — or an error saying why it cannot be. */
export function toJson(value: unknown, what: string): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new NotificationDataError(`${what} cannot be stored as JSON: ${(error as Error).message}`);
  }
  if (json === undefined) throw new NotificationDataError(`${what} cannot be stored as JSON (it is ${typeof value}).`);
  return JSON.parse(json);
}
