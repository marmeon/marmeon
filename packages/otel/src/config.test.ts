import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { OtelConfig } from './index.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([OtelConfig], env)).get(OtelConfig) as OtelConfig;

describe('OtelConfig: variable names', () => {
  it('trusts no traceparent and records no query values by default', async () => {
    expect(await resolve({})).toMatchObject({ disabled: false, trustTraceparent: false, recordQueryValues: false });
    // An empty variable is a missing one.
    expect(await resolve({ MARMEON_OTEL_RECORD_QUERY_VALUES: '', MARMEON_OTEL_TRUST_TRACEPARENT: '' })).toMatchObject({ trustTraceparent: false, recordQueryValues: false });
  });

  it('reads the two switches with env.boolean(): true, false, 1 and 0 in any case — anything else is an error, never "on"', async () => {
    expect(await resolve({ MARMEON_OTEL_TRUST_TRACEPARENT: 'TRUE', MARMEON_OTEL_RECORD_QUERY_VALUES: '1' })).toMatchObject({ trustTraceparent: true, recordQueryValues: true });
    expect(await resolve({ MARMEON_OTEL_TRUST_TRACEPARENT: '0', MARMEON_OTEL_RECORD_QUERY_VALUES: 'false' })).toMatchObject({ trustTraceparent: false, recordQueryValues: false });
    await expect(resolve({ MARMEON_OTEL_TRUST_TRACEPARENT: 'yes' })).rejects.toThrow(/MARMEON_OTEL_TRUST_TRACEPARENT/);
    await expect(resolve({ MARMEON_OTEL_RECORD_QUERY_VALUES: 'on' })).rejects.toThrow(/MARMEON_OTEL_RECORD_QUERY_VALUES/);
  });

  // The specification's switch: only `true` (any case) disables the SDK, so Marmeon follows it — or the two would disagree
  // about whether spans are recorded.
  it('reads OTEL_SDK_DISABLED as the SDK does: only true, in any case; 1 does not disable', async () => {
    expect((await resolve({ OTEL_SDK_DISABLED: 'True' })).disabled).toBe(true);
    expect((await resolve({ OTEL_SDK_DISABLED: '1' })).disabled).toBe(false);
  });

  it.each([
    ['OTEL_TRUST_TRACEPARENT', 'MARMEON_OTEL_TRUST_TRACEPARENT'],
    ['OTEL_RECORD_QUERY_VALUES', 'MARMEON_OTEL_RECORD_QUERY_VALUES'],
  ])('stops the start when %s is set, naming %s, instead of falling back to the default', async (from, to) => {
    const error = await resolve({ [from]: 'true' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});
