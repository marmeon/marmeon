import { describe, expect, it } from 'vitest';
import { toSocialUser } from './social-user.ts';
import { started } from './test-helpers/callback.ts';
import { verifiedInfo } from './verified.ts';

const tokens = { accessToken: 'token', scopes: [] };
const build = (mapped: Record<string, unknown>) => toSocialUser('idp', {}, { id: '1', email: null, emailVerified: false, name: null, nickname: null, avatar: null, ...mapped }, tokens);

describe('the SocialUser of a provider', () => {
  it('drops an avatar that is not https', () => {
    for (const avatar of ['http://cdn.example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//cdn.example.com/a.png', 'not a url', '', 7, `https://cdn.example.com/${'a'.repeat(2100)}`]) {
      expect(build({ avatar })?.avatar, String(avatar)).toBeNull();
    }
    expect(build({ avatar: 'https://cdn.example.com/a.png' })?.avatar).toBe('https://cdn.example.com/a.png');
  });

  it('lower-cases and trims the email', () => {
    expect(build({ email: '  Ada@Example.COM ' })?.email).toBe('ada@example.com');
    for (const email of ['no-at-sign', '', '   ', 7, `${'a'.repeat(250)}@example.com`]) expect(build({ email })?.email, String(email)).toBeNull();
  });

  it('reports emailVerified only for exactly true and an email', () => {
    expect(build({ email: 'a@b.c', emailVerified: true })?.emailVerified).toBe(true);
    for (const emailVerified of ['true', 1, 'yes', {}, [], undefined, false]) expect(build({ email: 'a@b.c', emailVerified })?.emailVerified, String(emailVerified)).toBe(false);
    // Verified for an address that is not there, or that was dropped, is not verified.
    expect(build({ email: null, emailVerified: true })?.emailVerified).toBe(false);
    expect(build({ email: 'broken', emailVerified: true })?.emailVerified).toBe(false);
  });

  it('refuses an id that is not well formed and drops a name or address that is not', () => {
    expect(build({ id: 'idp-\uD800' })).toBeUndefined();
    expect(build({ id: 'idp-\uFFFD' })?.id).toBe('idp-\uFFFD');
    expect(build({ name: 'Ada\uD800', nickname: 'ada\uDC00', email: 'a\uD800@example.com' })).toMatchObject({ name: null, nickname: null, email: null });
  });

  it('refuses an empty or over-long id', () => {
    for (const id of ['', '   ', 'x'.repeat(256), 42, null, undefined]) expect(build({ id }), String(id)).toBeUndefined();
    expect(build({ id: ' 7 ' })?.id).toBe('7');
    expect(build({ id: 'x'.repeat(255) })?.id).toHaveLength(255);
    expect(toSocialUser('idp', {}, null, tokens)).toBeUndefined();
  });

  it('refuses an address that is more than one, or no address the mailer takes, and any character that lower-casing would change', () => {
    for (const email of ['a@b.c\r\nBcc: x@y.z', 'a@b.c, d@e.f', 'Name <a@b.c>', '"Name" a@b.c', '@', 'a@@b.c', 'a@b.c;d@e.f', 'a b@c.d', 'a\u0000@b.c', '\u212Aa@b.c', 'Ä@b.c', 'a@b\t.c']) {
      expect(build({ email, emailVerified: true })?.email, JSON.stringify(email)).toBeNull();
      expect(build({ email, emailVerified: true })?.emailVerified, JSON.stringify(email)).toBe(false);
    }
    expect(build({ email: 'Ada.Lovelace+x@Example.COM' })?.email).toBe('ada.lovelace+x@example.com');
  });

  it('refuses each forbidden character in either half of an address, and an address without a half', () => {
    for (const c of ['<', '>', '(', ')', '"', ',', ';', ':', '\\', '[', ']', '\u0000', '\u007f', '\u0085', ' ', '\u202e', '\u200b']) {
      for (const email of [`a${c}b@x.y`, `a@x${c}y.z`]) {
        expect(build({ email, emailVerified: true })?.email, JSON.stringify(email)).toBeNull();
        expect(build({ email, emailVerified: true })?.emailVerified, JSON.stringify(email)).toBe(false);
      }
    }
    for (const email of ['@b.c', 'a@']) expect(build({ email, emailVerified: true })?.email, email).toBeNull();
  });

  it('refuses an id with a control or format character, and drops such a name or nickname', () => {
    for (const id of ['a\u202eb', 'a\u200bb']) expect(build({ id }), JSON.stringify(id)).toBeUndefined();
    expect(build({ name: 'Ada\u202e', nickname: 'a\u0000b' })).toMatchObject({ name: null, nickname: null });
    expect(build({ name: 'Ada Lovelace' })?.name).toBe('Ada Lovelace');
  });

  it('refuses an id with a control character, NUL included', () => {
    for (const id of ['a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b']) expect(build({ id }), JSON.stringify(id)).toBeUndefined();
    expect(build({ id: 'user-1' })?.id).toBe('user-1');
  });

  it('reads each field once, so a getter cannot answer differently the second time', () => {
    let reads = 0;
    const mapped = {
      get id() {
        reads += 1;
        return reads === 1 ? 'good' : { toString: () => 'evil' };
      },
      email: null,
    };
    expect(toSocialUser('idp', {}, mapped, tokens)?.id).toBe('good');
    expect(reads).toBe(1);
    expect(() =>
      toSocialUser('idp', {}, { get id(): string { throw new Error('quotes access-secret'); } }, tokens),
    ).toThrow();
  });

  it('keeps a name and a nickname of at most 255 characters and drops the rest', () => {
    expect(build({ name: 'Ada', nickname: 'ada' })).toMatchObject({ name: 'Ada', nickname: 'ada' });
    expect(build({ name: 'x'.repeat(256), nickname: 5 })).toMatchObject({ name: null, nickname: null });
  });

  it('marks what callback() returned with its intent and flow user, and nothing else', async () => {
    const { oauth, query } = await started({}, { intent: 'link', userId: 'u-1' });
    const result = await oauth.callback('idp', query(), { userId: 'u-1' });
    if (!result.ok) throw new Error('expected a user');
    expect(verifiedInfo(result.value.user)).toMatchObject({ intent: 'link', flowUserId: 'u-1' });
    // A copy, or an object of the app's own making, is not the flow's result.
    expect(verifiedInfo({ ...result.value.user })).toBeUndefined();
    expect(verifiedInfo(build({}))).toBeUndefined();
  });
});
