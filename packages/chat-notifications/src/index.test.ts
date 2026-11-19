import { describe, expect, it } from 'vitest';
import * as entry from './index.ts';

describe('the package entry', () => {
  it('exports the errors and nothing internal', () => {
    expect(Object.keys(entry).sort()).toEqual(['ChatDeliveryError', 'ChatError']);
    expect(entry.ChatDeliveryError.prototype).toBeInstanceOf(entry.ChatError);
  });
});
