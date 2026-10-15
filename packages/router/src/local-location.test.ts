import { describe, expect, it } from 'vitest';
import { localLocation } from './local-location.ts';

describe('localLocation', () => {
  it('keeps a derived location on this site: leading slashes and backslashes collapse to one', () => {
    for (const pathname of ['//evil.example/x', '///evil.example/x', '/\\evil.example/x', '\\\\evil.example/x', '/\\/evil.example/x']) {
      expect(localLocation(pathname, '?bad=1')).toBe('/evil.example/x?bad=1');
    }
    expect(localLocation('/a//b', '?q=1')).toBe('/a//b?q=1');
    expect(localLocation('/%2f/evil')).toBe('/%2f/evil');
    expect(localLocation('/')).toBe('/');
  });
});
