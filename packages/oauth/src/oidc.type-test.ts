// Type guarantees of `oidc()` — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import type { OAuthProviderFactory } from './definition.ts';
import { oidc, type IdTokenClaims } from './oidc.ts';

// The options that are allowed.
void oidc();
void oidc({ issuer: 'https://idp.example.com', label: 'Example', scopes: ['openid'], userinfo: true, clientAuth: 'client_secret_basic', authorizeParams: { hd: 'example.com' }, allowAddresses: ['10.0.0.0/8'] });
void oidc({
  acceptedIssuers: (claims) => [String(claims.iss)],
  mapUser: (claims) => ({ id: `${claims.iss}|${claims.sub}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null }),
});

// @ts-expect-error a misspelt key is no option
void oidc({ userInfo: true });
const mapUser = (claims: IdTokenClaims) => ({ id: `${claims.iss}|${claims.sub}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null });
// @ts-expect-error acceptedIssuers is a function, not a list
void oidc({ acceptedIssuers: ['https://idp.example.com'], mapUser });
// @ts-expect-error acceptedIssuers answers at once; a promise would be refused
void oidc({ acceptedIssuers: async () => ['https://idp.example.com'], mapUser });
// @ts-expect-error acceptedIssuers needs a mapUser that puts the issuer into the id
void oidc({ acceptedIssuers: () => ['https://x'] });
// @ts-expect-error mapUser answers at once; a promise would end the sign-in
void oidc({ mapUser: async () => ({ id: '1', email: null, emailVerified: false, name: null, nickname: null, avatar: null }) });
// @ts-expect-error a profile is more than its id
void oidc({ mapUser: () => ({ id: '1' }) });
// @ts-expect-error userinfo is true or false
void oidc({ userinfo: 'yes' });

expectTypeOf<ReturnType<typeof oidc>>().toEqualTypeOf<OAuthProviderFactory>();
expectTypeOf<IdTokenClaims['sub']>().toEqualTypeOf<string>();
expectTypeOf<IdTokenClaims['iss']>().toEqualTypeOf<string>();
