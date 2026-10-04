import { EncryptionConfig, generateKey } from '@bespokecore/encryption';
import { describe, expect, it } from 'vitest';
import { SessionEpoch } from './session-epoch.ts';

const keyOf = (key: string) => Buffer.from(key.slice('base64:'.length), 'base64');
const epochs = (key = generateKey()) => new SessionEpoch({ key: keyOf(key), previousKeys: [] } as unknown as EncryptionConfig);

describe('SessionEpoch (W8 step 8, E165)', () => {
  it('the same input, the same epoch — opaque, short, base64url', () => {
    const key = generateKey();
    const epoch = epochs(key).of('scope-1\n7', 'de');
    expect(epoch).toMatch(/^[\w-]{22}$/);
    expect(epochs(key).of('scope-1\n7', 'de')).toBe(epoch);
    for (const part of ['scope-1', '7', 'de']) expect(epoch).not.toContain(part);
  });

  it('another generation, user or locale — another epoch; a guest has one per locale', () => {
    const epoch = epochs();
    const all = [epoch.of('scope-1\n7', 'en'), epoch.of('scope-2\n7', 'en'), epoch.of('scope-1\n8', 'en'), epoch.of('scope-1\n7', 'de'), epoch.of(undefined, 'en'), epoch.of(undefined, 'de'), epoch.of(undefined, undefined)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keyed by APP_KEY: another key, another epoch for the same session', () => {
    expect(epochs().of('scope-1\n7', 'en')).not.toBe(epochs().of('scope-1\n7', 'en'));
  });
});
