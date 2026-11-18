import type { OAuthTokens, SocialUser } from './definition.ts';

const MAX_TEXT = 255;
const MAX_AVATAR = 2048;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length <= MAX_TEXT && !CONTROL.test(value) ? value : null);

// One address in the form the mailer accepts: no white space, no control characters, none of < > ( ) , ; : " [ ] \ and one @.
const EMAIL = /^[^\s\p{Cc}\p{Cf}@<>()",;:\\[\]]+@[^\s\p{Cc}\p{Cf}@<>()",;:\\[\]]+$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * The address as lower case text when it is one address of at most 255 characters, else `null`. Only ASCII letters are lower-cased: a
 * character that lower-casing would change (the Kelvin sign) makes two spellings of one address that a database compares differently.
 */
function emailOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const email = trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (email !== trimmed.toLowerCase() || email.length > MAX_TEXT) return null;
  return EMAIL.test(email) ? email : null;
}

/** The address of a picture when it is an `https:` URL, else `null`: a `javascript:` or `data:` address never reaches a page. */
function avatarOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AVATAR) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Checks what a provider's `mapUser` returned and builds the {@link SocialUser}, or answers `undefined` when the answer has no
 * usable `id`. `mapUser` is the provider's code, so its answer is as untrusted as the provider's server: the e-mail address is
 * one address in ASCII lower case, `emailVerified` is true only for exactly `true` next to an address, and an avatar is kept only as `https:`.
 */
export function toSocialUser(provider: string, raw: unknown, mapped: unknown, tokens: OAuthTokens): SocialUser | undefined {
  if (typeof mapped !== 'object' || mapped === null) return undefined;
  // Each property is read once, so a getter cannot answer differently the second time.
  const { id: rawId, email: rawEmail, emailVerified, name, nickname, avatar } = mapped as Record<string, unknown>;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (id === '' || id.length > MAX_TEXT || CONTROL.test(id)) return undefined;
  const email = emailOf(rawEmail);
  return {
    provider,
    id,
    email,
    emailVerified: email !== null && emailVerified === true,
    name: textOrNull(name),
    nickname: textOrNull(nickname),
    avatar: avatarOf(avatar),
    raw,
    tokens,
  };
}
