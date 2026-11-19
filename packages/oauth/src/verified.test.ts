import { describe, expect, it } from 'vitest';
import type { SocialUser } from './definition.ts';
import { consumeVerified, markVerified, verifiedInfo } from './verified.ts';

const user = (): SocialUser => ({
  provider: 'idp',
  id: '42',
  email: 'ada@example.com',
  emailVerified: true,
  name: null,
  nickname: null,
  avatar: null,
  raw: {},
  tokens: { accessToken: 'token', scopes: ['read'] },
});

describe('verified users', () => {
  it('knows only the users the flow marked', () => {
    const marked = user();
    markVerified(marked, { intent: 'sign-in', flowUserId: undefined });
    expect(verifiedInfo(marked)?.intent).toBe('sign-in');
    expect(verifiedInfo({ ...marked })).toBeUndefined();
    expect(verifiedInfo(user())).toBeUndefined();
    expect(verifiedInfo(null)).toBeUndefined();
    expect(verifiedInfo('idp')).toBeUndefined();
  });

  it('records the identity as it was when marked, and refuses a change afterwards', () => {
    const marked = user();
    markVerified(marked, { intent: 'link', flowUserId: '7', reauthenticatedAt: 1000 });
    expect(() => {
      (marked as { id: string }).id = '43';
    }).toThrow(TypeError);
    expect(() => {
      (marked as { emailVerified: boolean }).emailVerified = false;
    }).toThrow(TypeError);
    expect(() => {
      (marked.tokens as { accessToken: string }).accessToken = 'other';
    }).toThrow(TypeError);
    expect(() => (marked.tokens.scopes as string[]).push('write')).toThrow(TypeError);
    const info = verifiedInfo(marked)!;
    expect(info.subject).toEqual({ provider: 'idp', id: '42', email: 'ada@example.com', emailVerified: true });
    expect(info).toMatchObject({ intent: 'link', flowUserId: '7', reauthenticatedAt: 1000 });
    expect(() => {
      (info.subject as { id: string }).id = 'x';
    }).toThrow(TypeError);
  });

  it('holds the time as a number that cannot be changed after marking', () => {
    const marked = user();
    markVerified(marked, { intent: 'confirm', flowUserId: '7', reauthenticatedAt: 1000 });
    const info = verifiedInfo(marked)!;
    expect(info.reauthenticatedAt).toBe(1000);
    expect(typeof info.reauthenticatedAt).toBe('number');
    expect(() => {
      (info as { reauthenticatedAt: number }).reauthenticatedAt = 5000;
    }).toThrow(TypeError);
    expect(verifiedInfo(marked)?.reauthenticatedAt).toBe(1000);
  });

  it('spends a result once when consumed', () => {
    const marked = user();
    markVerified(marked, { intent: 'sign-in', flowUserId: undefined });
    expect(consumeVerified(marked)?.subject.id).toBe('42');
    expect(consumeVerified(marked)).toBeUndefined();
    expect(verifiedInfo(marked)).toBeUndefined();
  });
});
