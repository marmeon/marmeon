import { describe, expect, it } from 'vitest';
import { activeEnv, oauthApp } from '../test-helpers/app.ts';
import { builtinWith, fixture, tokenResponse } from '../test-helpers/builtin.ts';
import { NOW, idToken } from '../test-helpers/oidc.ts';
import { expectA11, failure } from '../test-helpers/start.ts';
import { microsoft } from './microsoft.ts';

const HOST = 'https://login.microsoftonline.com';
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
const CONTOSO = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const FABRIKAM = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
const issuerOf = (tid: string): string => `${HOST}/${tid}/v2.0`;

/** The discovery of the tenant setting `tenant` (`undefined` is the default, `common`). */
function setting(tenant: string | undefined) {
  const where = tenant ?? 'common';
  const wide = where === 'common' || where === 'organizations';
  const guid = where === 'consumers' ? CONSUMERS : where.toLowerCase();
  const base = `${HOST}/${wide ? where : guid}`;
  const tokenUrl = `${base}/oauth2/v2.0/token`;
  return {
    tokenUrl,
    options: tenant === undefined ? { TENANT: undefined } : { TENANT: tenant },
    // `consumers` is looked up under its keyword and names its GUID; `common` and `organizations` name the placeholder.
    document: {
      url: where === 'consumers' ? `${HOST}/consumers/v2.0/.well-known/openid-configuration` : `${base}/v2.0/.well-known/openid-configuration`,
      body: { issuer: wide ? `${HOST}/{tenantid}/v2.0` : issuerOf(guid), authorization_endpoint: `${base}/oauth2/v2.0/authorize`, token_endpoint: tokenUrl },
    },
  };
}

/** A Microsoft flow for the tenant setting; `claims` are added to the invented profile (`iss` follows `tid` unless given). */
async function signIn(tenant: string | undefined, claims: Record<string, unknown> = {}, intent?: 'confirm') {
  const made = builtinWith(microsoft, 'microsoft', setting(tenant));
  const merged: Record<string, unknown> = { ...fixture('microsoft-claims'), ...claims };
  if (!('iss' in claims) && typeof merged.tid === 'string') merged.iss = issuerOf(merged.tid);
  const { query } = await made.begin((flow) => tokenResponse({ id_token: idToken({ nonce: flow.nonce, ...merged }) }), intent, `${String(merged.tid)}|${String(merged.sub)}`);
  return { ...made, result: await made.oauth.callback('microsoft', query, intent === undefined ? {} : { userId: 7 }) };
}

const refused = { ok: false, error: { kind: 'invalid-response' } };

describe('microsoft', () => {
  it('never reports an email as verified', async () => {
    for (const tenant of [undefined, 'organizations', 'consumers', CONTOSO]) {
      const tid = tenant === 'consumers' ? CONSUMERS : tenant === undefined || tenant === 'organizations' ? CONTOSO : tenant;
      // Whatever flags the token carries about the address.
      const { result } = await signIn(tenant, { tid, email_verified: true, xms_edov: true, email: 'ada@contoso.example' });
      if (!result.ok) throw new Error(`${String(tenant)}: expected a user, got ${result.error.kind}`);
      expect(result.value.user, String(tenant)).toMatchObject({ email: 'ada@contoso.example', emailVerified: false, nickname: 'ada@contoso.example', avatar: null });
    }
  });

  it('accepts the issuer of the token\'s tenant under common', async () => {
    for (const tid of [CONTOSO, FABRIKAM, CONSUMERS]) {
      const { result } = await signIn(undefined, { tid });
      if (!result.ok) throw new Error(`${tid}: expected a user, got ${result.error.kind}`);
      // The tenant is part of the id: one sub in two tenants is two people.
      expect(result.value.user.id).toBe(`${tid}|${fixture('microsoft-claims').sub}`);
    }
    // The issuer must be the one of the tid the token names.
    expect((await signIn(undefined, { tid: CONTOSO, iss: issuerOf(FABRIKAM) })).result).toEqual(refused);
    expect((await signIn(undefined, { tid: CONTOSO, iss: `${HOST}/common/v2.0` })).result).toEqual(refused);
    expect((await signIn(undefined, { tid: CONTOSO, iss: `${issuerOf(CONTOSO)}/` })).result).toEqual(refused);
  });

  it('refuses a tid that is no GUID under common', async () => {
    for (const tid of ['contoso.example', '../common', `x${CONTOSO}`, `a/${CONTOSO}`, CONTOSO.toUpperCase(), `${CONTOSO} `, 'common', '', 5, null, undefined]) {
      expect((await signIn(undefined, { tid, iss: typeof tid === 'string' ? issuerOf(tid) : issuerOf(CONTOSO) })).result, String(tid)).toEqual(refused);
    }
  });

  it('refuses the consumer tenant under organizations', async () => {
    expect((await signIn('organizations', { tid: CONSUMERS })).result).toEqual(refused);
    expect((await signIn('organizations', { tid: CONTOSO })).result.ok).toBe(true);
  });

  it('expects the consumer tenant under consumers', async () => {
    expect((await signIn('consumers', { tid: CONSUMERS })).result.ok).toBe(true);
    expect((await signIn('consumers', { tid: CONTOSO })).result).toEqual(refused);
    expect((await signIn('consumers', { tid: CONSUMERS, iss: issuerOf(CONTOSO) })).result).toEqual(refused);
  });

  it('refuses a token of another tenant when a tenant id is configured', async () => {
    expect((await signIn(CONTOSO, { tid: CONTOSO })).result.ok).toBe(true);
    // The tid of another tenant with its own issuer, the issuer of the configured tenant with another tid, and a mix of both.
    expect((await signIn(CONTOSO, { tid: FABRIKAM })).result).toEqual(refused);
    expect((await signIn(CONTOSO, { tid: FABRIKAM, iss: issuerOf(CONTOSO) })).result).toEqual(refused);
    expect((await signIn(CONTOSO, { tid: CONTOSO, iss: issuerOf(FABRIKAM) })).result).toEqual(refused);
    expect((await signIn(CONTOSO, { tid: undefined, iss: issuerOf(CONTOSO) })).result).toEqual(refused);
  });

  it('takes a tenant id in capitals, and compares it to the lower case tid', async () => {
    expect((await signIn(CONTOSO.toUpperCase(), { tid: CONTOSO })).result.ok).toBe(true);
  });

  it('stops the start for a tenant given as a domain name', async () => {
    const env = { ...activeEnv('microsoft') };
    for (const tenant of ['contoso.onmicrosoft.com', 'Common', 'consumer', '/common', 'common ', `x${CONTOSO}`, `a/${CONTOSO}`]) {
      const message = expectA11(await failure(oauthApp([], { ...env, OAUTH_MICROSOFT_TENANT: tenant })));
      expect(message, tenant).toMatch(/is not common, organizations, consumers or a tenant ID \(keywords are lower case\)/);
    }
    // An inactive provider is never built, so its tenant is not looked at; an empty variable is not set.
    await oauthApp([], { OAUTH_MICROSOFT_TENANT: 'contoso.onmicrosoft.com' });
    await oauthApp([], { ...env, OAUTH_MICROSOFT_TENANT: '' });
    for (const tenant of ['common', 'organizations', 'consumers', CONTOSO]) await oauthApp([], { ...env, OAUTH_MICROSOFT_TENANT: tenant });
  });

  it('confirms nothing without the optional auth_time claim', async () => {
    const claims = { tid: CONTOSO, sub: 'user-1' };
    const { result } = await signIn(undefined, claims, 'confirm');
    expect(result).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    const withTime = await signIn(undefined, { ...claims, auth_time: NOW / 1000 }, 'confirm');
    expect(withTime.result.ok && withTime.result.value.intent).toBe('confirm');
  });

  it('asks the tenant\'s endpoint for the openid, profile and email scopes', async () => {
    const { redirect } = await builtinWith(microsoft, 'microsoft', setting(undefined)).begin(() => tokenResponse());
    expect(redirect.origin + redirect.pathname).toBe(`${HOST}/common/oauth2/v2.0/authorize`);
    expect(redirect.searchParams.get('scope')).toBe('openid profile email');
  });
});
