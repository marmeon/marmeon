import { errorCodeOf } from '@marmeon/core';
import { expect } from 'vitest';
import { OAuthSetupError } from '../config.ts';

/** The error a start failed with, or `undefined` when it did not fail. */
export const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

/** Asserts that `error` is the A11 refusal of the registry — an `OAuthSetupError` with the code — and returns its message. */
export function expectA11(error: unknown): string {
  expect(error).toBeInstanceOf(OAuthSetupError);
  expect(errorCodeOf(error)).toBe('A11');
  return (error as Error).message;
}
