// Type guarantees of `defineOAuthProvider()` — checked by `tsc` (typecheck), never run.
import type { ServiceProviderClass } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import { oauthCredentials } from './credentials.ts';
import { defineOAuthProvider, type OAuthProviderFactory, type SocialProfile } from './definition.ts';
import './provider.ts';

const base = { label: 'X', endpoints: { authorizeUrl: 'https://x.test/a', tokenUrl: 'https://x.test/t' }, scopes: [] };

// mapUser answers a profile with id: string and emailVerified: boolean.
defineOAuthProvider({
  ...base,
  profile: async () => ({}),
  mapUser: () => ({ id: '1', email: null, emailVerified: true, name: null, nickname: null, avatar: null }),
});
defineOAuthProvider({
  ...base,
  profile: async () => ({}),
  // @ts-expect-error id is a string
  mapUser: () => ({ id: 1, email: null, emailVerified: true, name: null, nickname: null, avatar: null }),
});
defineOAuthProvider({
  ...base,
  profile: async () => ({}),
  // @ts-expect-error emailVerified is a boolean
  mapUser: () => ({ id: '1', email: null, emailVerified: 'yes', name: null, nickname: null, avatar: null }),
});

// What profile() returns is what mapUser() takes.
defineOAuthProvider({
  ...base,
  profile: async () => ({ sub: 'abc', verified: true }),
  mapUser: (raw) => {
    expectTypeOf(raw).toEqualTypeOf<{ sub: string; verified: boolean }>();
    return { id: raw.sub, email: null, emailVerified: raw.verified, name: null, nickname: null, avatar: null };
  },
});
defineOAuthProvider<{ sub: string }>({
  ...base,
  profile: async () => ({ sub: 'abc' }),
  // @ts-expect-error mapUser reads a field profile() does not return
  mapUser: (raw) => ({ id: raw.id, email: null, emailVerified: true, name: null, nickname: null, avatar: null }),
});

expectTypeOf(defineOAuthProvider(() => ({ ...base, profile: async () => ({}), mapUser: () => ({}) as SocialProfile }))).toEqualTypeOf<OAuthProviderFactory>();

// A mapUser that reads more than profile() returns does not compile — a parameter wider than the answer is no escape hatch either.
defineOAuthProvider({
  ...base,
  // @ts-expect-error profile() returns {}, which is not the annotated parameter of mapUser
  profile: async () => ({}),
  mapUser: (raw: { sub: string }) => ({ id: raw.sub, email: null, emailVerified: true, name: null, nickname: null, avatar: null }),
});
defineOAuthProvider({
  ...base,
  // @ts-expect-error http.json() returns unknown, which is not the annotated parameter of mapUser
  profile: ({ http }) => http.json('https://x.test/me'),
  mapUser: (raw: { sub: string }) => ({ id: raw.sub, email: null, emailVerified: true, name: null, nickname: null, avatar: null }),
});

// What a provider class brings is a factory made by defineOAuthProvider, never a bare definition or anything else.
const fine: ServiceProviderClass[] = [class { static oauthProviders = { x: defineOAuthProvider({ ...base, profile: async () => ({}), mapUser: () => ({}) as SocialProfile }) }; }];
expectTypeOf(fine).toBeArray();
const bare: ServiceProviderClass[] = [
  // @ts-expect-error a definition is not a factory: wrap it in defineOAuthProvider()
  class { static oauthProviders = { x: { ...base, profile: async () => ({}), mapUser: () => ({}) as SocialProfile } }; },
];
const number: ServiceProviderClass[] = [
  // @ts-expect-error a number is not a factory
  class { static oauthProviders = { x: 1 }; },
];
expectTypeOf(bare).toBeArray();
expectTypeOf(number).toBeArray();

// issuer is 'required' or 'optional'.
// @ts-expect-error a mistyped issuer rule
oauthCredentials('idp', { issuer: 'requird' });
