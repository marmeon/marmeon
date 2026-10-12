import { createTestApp } from '@marmeon/testing';
import { expect } from 'vitest';
import application from '../../bootstrap/app.ts';

/**
 * For tests of every route that writes absolute URLs: an app whose APP_URL differs from the test request's origin
 * (`http://localhost`) is asked with a forged `Host` and `X-Forwarded-Host`; the picked value must be `expected`, and the forged
 * host must appear nowhere in the answer, nor the request's origin in its headers.
 */
export async function expectOriginFromAppUrl(path: string, pick: (response: { headers: Headers; body: string }) => string | null, expected: string, headers: Record<string, string> = {}): Promise<void> {
  const other = await createTestApp(application, { env: { APP_URL: 'https://docs.example' } });
  const response = await other.get(path, { headers: { ...headers, host: 'forged-host.invalid', 'x-forwarded-host': 'forged-host.invalid', 'x-forwarded-proto': 'http' } }).assertOk();
  expect(pick(response)).toBe(expected);
  expect(JSON.stringify([...response.headers])).not.toContain('localhost');
  expect(JSON.stringify([...response.headers]) + response.body).not.toContain('forged-host.invalid');
}
