import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPasswordField, isSensitiveField } from './sensitive-fields.ts';

describe('isSensitiveField', () => {
  it('writes no modifier group in its regular expressions: older browsers refuse a module that has one', () => {
    expect(readFileSync(new URL('./sensitive-fields.ts', import.meta.url), 'utf8')).not.toMatch(/\(\?[-ims]+:/);
  });

  it.each(['password', 'userOtp', 'user_totp', 'otpCode', 'smsCode', 'api_key', 'session-id', 'code', 'payment.userTotp', 'items[0].secret', 'authCode', 'AUTH'])('%s is sensitive', (field) => {
    expect(isSensitiveField(field)).toBe(true);
  });

  it.each(['footprint', 'rootPath', 'zip_code', 'promoCode', 'name', 'email', 'notebook', 'items[0].title'])('%s is not', (field) => {
    expect(isSensitiveField(field)).toBe(false);
  });

  it('tells a camel-case boundary by its capital: only a lower-case letter before it counts', () => {
    expect(isSensitiveField('xOtp')).toBe(true);
    expect(isSensitiveField('xTotp')).toBe(true);
    expect(isSensitiveField('1Otp')).toBe(false);
  });
});

describe('isPasswordField', () => {
  it('is a password, whatever its case', () => {
    expect(isPasswordField('Password')).toBe(true);
    expect(isPasswordField('pass')).toBe(true);
    expect(isPasswordField('passage')).toBe(false);
  });
});
