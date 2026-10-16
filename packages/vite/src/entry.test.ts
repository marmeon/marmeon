import { describe, expect, it } from 'vitest';
import * as vite from './index.ts';

describe('the entry point of the Vite plugin', () => {
  it('exports the plugin and nothing else', () => {
    expect(Object.keys(vite)).toEqual(['marmeon']);
  });
});
