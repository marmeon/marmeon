import { describe, expect, it } from 'vitest';
import { parts } from './ci.ts';

describe('pnpm run ci (E111)', () => {
  it('never runs the Gegenproben — they patch the working tree (E188: pnpm gegen is run by hand, not by CI)', () => {
    const gegen = parts.filter((part) => /gegen/.test(`${part.name} ${part.command.join(' ')}`)).map((part) => part.name);
    expect(gegen).toEqual([]);
  });
});
