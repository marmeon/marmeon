import { Translator } from '@marmeon/core';
import { PreferredLocale } from '@marmeon/core/internal';
import { EncryptionConfig, generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { PageSession } from './page-session.ts';
import { epochOf, SessionEpoch } from './session-epoch.ts';

const keyOf = (key: string) => Buffer.from(key.slice('base64:'.length), 'base64');
const epochs = (key = generateKey()) => new SessionEpoch({ key: keyOf(key), previousKeys: [] } as unknown as EncryptionConfig);

describe('SessionEpoch', () => {
  it('the same input, the same epoch — opaque, short, base64url', () => {
    const key = generateKey();
    const epoch = epochs(key).of('scope-generation\nuser-4711', 'de');
    expect(epoch).toMatch(/^[\w-]{22}$/);
    expect(epochs(key).of('scope-generation\nuser-4711', 'de')).toBe(epoch);
    // Nothing of the input shows (parts long enough not to turn up in 22 random characters by chance — `7` or `de` would).
    for (const part of ['scope', 'generation', '4711']) expect(epoch).not.toContain(part);
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

describe('epochOf', () => {
  /** The scope of a request: the session's generation, the locale of its URL and the one its visitor prefers. */
  const scopeOf = (epoch: SessionEpoch, { generation, url, preferred }: { generation?: string; url: string; preferred?: string }) => {
    const services = new Map<unknown, unknown>([
      [SessionEpoch, epoch],
      [PageSession, { generation: () => generation }],
      [Translator, { locale: url }],
      ...(preferred !== undefined ? [[PreferredLocale, { value: preferred }] as [unknown, unknown]] : []),
    ]);
    return { has: (key: unknown) => services.has(key), make: (key: unknown) => services.get(key) } as unknown as Parameters<typeof epochOf>[0];
  };

  it('is the same on the pages of every language of one session: it follows the preferred locale, not the URL', () => {
    const epoch = epochs();
    const german = epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'de', preferred: 'en' }));
    expect(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'en', preferred: 'en' }))).toBe(german);
    expect(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'de', preferred: 'de' }))).not.toBe(german);
  });

  it('follows the translator where no preferred locale is bound — a route that is not localized', () => {
    const epoch = epochs();
    expect(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'de' }))).toBe(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'x', preferred: 'de' })));
    expect(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'de' }))).not.toBe(epochOf(scopeOf(epoch, { generation: 'g1\n7', url: 'en' })));
  });
});
