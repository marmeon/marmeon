import { describe, expect, it } from 'vitest';
import { builtinWith, fixture, tokenResponse } from '../test-helpers/builtin.ts';
import { discord } from './discord.ts';

const TOKEN_URL = 'https://discord.com/api/oauth2/token';

async function signIn(user: Record<string, unknown> = fixture('discord-user')) {
  const made = builtinWith(discord, 'discord', { tokenUrl: TOKEN_URL });
  const { query } = await made.begin(() => tokenResponse());
  made.http.respond('https://discord.com/api/users/@me', () => Response.json(user));
  const result = await made.oauth.callback('discord', query);
  if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
  return { ...made, user: result.value.user };
}

describe('discord', () => {
  it('reports verified only for verified: true', async () => {
    expect((await signIn()).user).toMatchObject({ provider: 'discord', id: '80351110224678912', email: 'ada@example.com', emailVerified: true, name: 'Ada', nickname: 'ada' });
    for (const verified of [false, 'true', 1, undefined]) {
      expect((await signIn({ ...fixture('discord-user'), verified })).user.emailVerified, String(verified)).toBe(false);
    }
    // No address, nothing to verify.
    expect((await signIn({ ...fixture('discord-user'), email: null })).user).toMatchObject({ email: null, emailVerified: false });
  });

  it('builds the avatar URL only from a plain hash', async () => {
    expect((await signIn()).user.avatar).toBe('https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png');
    for (const avatar of ['../../evil', 'a/b', 'a.png?x=1', 'a b', '', null]) {
      expect((await signIn({ ...fixture('discord-user'), avatar })).user.avatar, String(avatar)).toBeNull();
    }
    // The id goes into the path too: a non-numeric one gives no address.
    for (const id of ['a/../b', '1/../../x', '123abc', '1'.repeat(33)]) expect((await signIn({ ...fixture('discord-user'), id })).user.avatar, id).toBeNull();
  });

  it('refuses a confirmation', async () => {
    const { oauth, http } = builtinWith(discord, 'discord', { tokenUrl: TOKEN_URL });
    expect(await oauth.redirect('discord', { intent: 'confirm', userId: 7, account: '80351110224678912' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
    http.assertNothingSent();
  });

  it('asks for the endpoints, scopes and PKCE Discord documents', async () => {
    const { redirect } = await builtinWith(discord, 'discord', { tokenUrl: TOKEN_URL }).begin(() => tokenResponse());
    expect(redirect.origin + redirect.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(redirect.searchParams.get('scope')).toBe('identify email');
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
