import { createApplication } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { describe, expect, it, vi } from 'vitest';
import { AuthServiceProvider, combineFactors, TwoFactorState, TwoFactorStore } from '../index.ts';
import type { SecondFactor } from './state.ts';

const source = (...factors: SecondFactor[]): TwoFactorState => ({ factors: async () => factors });

describe('TwoFactorState default', () => {
  const boot = () => createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [AuthServiceProvider] });

  it('says nobody has a factor and asks no database', async () => {
    const app = await boot();
    const query = vi.spyOn(Connections.prototype, 'get');
    try {
      expect(await app.container.make(TwoFactorState).factors(1)).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it('is replaced by binding the store', async () => {
    const app = await boot();
    app.container.instance(Connections, {} as Connections); // the database provider is not part of this app
    app.container.bind(TwoFactorState, TwoFactorStore);
    expect(app.container.make(TwoFactorState)).toBeInstanceOf(TwoFactorStore);
  });
});

describe('combineFactors', () => {
  it('unites the factors of every source, each once', async () => {
    expect(await combineFactors(source('totp'), source('passkey'), source('totp')).factors(1)).toEqual(['totp', 'passkey']);
  });

  it('is empty when no source reports a factor, and for no sources at all', async () => {
    expect(await combineFactors(source(), source()).factors(1)).toEqual([]);
    expect(await combineFactors().factors(1)).toEqual([]);
  });
});
