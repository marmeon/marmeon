import { describe, expect, it } from 'vitest';
import { useRemember } from './remember.ts';

/** Never called: the type checker is the test (an unused `@ts-expect-error` fails the typecheck). */
function keys() {
  useRemember('tab', 'a');
  useRemember('footprint', 'a');
  useRemember('rootPath', 'a');
  useRemember('notPublished', 'a');
  useRemember('language_code', 'a');
  useRemember('promoCode', 'a');
  useRemember('zip_code', 'a');
  useRemember('api_token', 'a', { sensitive: true });
  useRemember('recovery_codes', 'a', { sensitive: true });
  // @ts-expect-error — a token is left out of remembered state unless asked for
  useRemember('api_token', 'a');
  // @ts-expect-error — a recovery code, in snake case
  useRemember('recovery_codes', 'a');
  // @ts-expect-error — a one-time code, in camel case
  useRemember('smsCode', 'a');
  // @ts-expect-error — `code` as the whole name
  useRemember('code', 'a');
  // @ts-expect-error — an `otp` as a word
  useRemember('user_otp', 'a');
  // @ts-expect-error — a camel-cased `otp`
  useRemember('userOtp', 'a');
  // @ts-expect-error — a private key
  useRemember('private_key', 'a');
  // @ts-expect-error — a passphrase is never remembered, not even when asked
  useRemember('passphrase', 'a', { sensitive: true });
}

describe('remember keys by type', () => {
  it('are checked at compile time', () => {
    expect(keys).toBeTypeOf('function');
  });
});
