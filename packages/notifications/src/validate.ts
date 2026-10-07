import type { StandardIssue as Issue, StandardSchemaV1 } from '@marmeon/core';

/** `ip: Invalid type: Expected string but received 7` — issues as one line. */
export function describeIssues(issues: readonly Issue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** A notification's data does not match its schema (when it is sent, or — after a deploy — when it is delivered). */
export class NotificationDataError extends Error {
  override name = 'NotificationDataError';
  readonly issues: readonly Issue[];

  constructor(message: string, issues: readonly Issue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** Validates against a schema — its output, or a {@link NotificationDataError} saying `what`. */
export async function validate(schema: StandardSchemaV1, value: unknown, what: string): Promise<unknown> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) throw new NotificationDataError(`${what}: ${describeIssues(result.issues)}`, result.issues);
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
