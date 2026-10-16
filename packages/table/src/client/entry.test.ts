import { describe, expect, it } from 'vitest';
import * as client from './index.ts';

describe('the client entry of the table package', () => {
  it('keeps what the React adapter uses', () => {
    expect(Object.keys(client).sort()).toEqual(['TableController', 'exportUrl', 'keyOf', 'sortUrl', 'tableStatus']);
  });
});
