import { describe, expect, it } from 'vitest';
import { bindTransaction, followsTransaction, runTransaction } from './transaction-context.ts';

describe('followsTransaction', () => {
  const connection = {};
  const other = {};

  it('is true for the handle of the current transaction and of a savepoint of the same connection inside it', async () => {
    const handle = {};
    await runTransaction(connection, 'main', async (frame) => {
      bindTransaction(handle, frame);
      expect(followsTransaction(handle)).toBe(true);
      await runTransaction(connection, 'main', async () => {
        expect(followsTransaction(handle)).toBe(true);
      });
    });
  });

  it('is false for a handle nothing bound, and outside every transaction', async () => {
    const handle = {};
    expect(followsTransaction(handle)).toBe(false);
    await runTransaction(connection, 'main', async (frame) => {
      expect(followsTransaction({})).toBe(false);
      bindTransaction(handle, frame);
    });
    expect(followsTransaction(handle)).toBe(false);
  });

  it('is false while the call chain is inside a transaction of another connection', async () => {
    const handle = {};
    await runTransaction(connection, 'main', async (frame) => {
      bindTransaction(handle, frame);
      await runTransaction(other, 'other', async () => {
        expect(followsTransaction(handle)).toBe(false);
      });
    });
  });

  it('is false for a stale handle used inside a later transaction of the same connection', async () => {
    const stale = {};
    await runTransaction(connection, 'main', async (frame) => bindTransaction(stale, frame));
    await runTransaction(connection, 'main', async () => {
      expect(followsTransaction(stale)).toBe(false);
    });
  });

  it('is false for the handle of a transaction the call chain is not in', async () => {
    const inner = {};
    await runTransaction(connection, 'main', async () => {
      await runTransaction(connection, 'main', async (frame) => bindTransaction(inner, frame));
      expect(followsTransaction(inner)).toBe(false);
    });
  });
});
