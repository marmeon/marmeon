import { describe, expect, it } from 'vitest';
import { defineOAuthProvider, type OAuthProviderContext } from './definition.ts';
import { definition } from './test-helpers/app.ts';

const context = (name: string): OAuthProviderContext => ({
  name,
  container: {} as never,
  credentials: { clientId: name, clientSecret: 's', redirectUrl: undefined, scopes: undefined, issuer: undefined, options: {} },
});

describe('defineOAuthProvider', () => {
  it('gives a function the name, credentials and container of the provider it creates', () => {
    const seen: OAuthProviderContext[] = [];
    const create = defineOAuthProvider((given) => (seen.push(given), definition({ label: given.name })));
    const first = context('one');
    expect(create(first).label).toBe('one');
    expect(create(context('two')).label).toBe('two');
    expect(seen[0]).toBe(first);
  });

  it('gives the object form to every context unchanged', () => {
    const fixed = definition();
    const create = defineOAuthProvider(fixed);
    expect(create(context('one'))).toBe(fixed);
    expect(create(context('two'))).toBe(fixed);
  });
});
