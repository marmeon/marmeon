import { describe, expect, it } from 'vitest';
import { parseManifest } from './SiteServiceProvider.ts';

describe('the manifest of the framework', () => {
  it('yields its version and a single SPDX license', () => {
    expect(parseManifest({ version: '1.0.0', license: 'Apache-2.0' })).toEqual({ version: '1.0.0', license: 'Apache-2.0' });
  });

  it.each([
    ['an expression', { version: '1.0.0', license: 'MIT OR Apache-2.0' }],
    ['parentheses', { version: '1.0.0', license: '(MIT)' }],
    ['no version', { license: 'MIT' }],
    ['no license', { version: '1.0.0' }],
    ['a license that is no string', { version: '1.0.0', license: ['MIT'] }],
  ])('refuses %s', (_, manifest) => {
    expect(() => parseManifest(manifest)).toThrow(/"version".*"license"/);
  });
});
