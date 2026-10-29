import { describe, expect, it } from 'vitest';
import { afterCommit, afterRollback, runTransaction } from './transaction-context.ts';

/** A turn like the driver's: one holder at a time, and `held` tells whether the caller holds it. */
function turnLike() {
  const state = { held: false };
  const turn = async <T>(run: () => Promise<T>): Promise<T> => {
    state.held = true;
    try {
      return await run();
    } finally {
      state.held = false;
    }
  };
  return { state, turn };
}

describe('runTransaction with a turn', () => {
  const owner = {};

  it('runs after-commit and after-rollback work after the turn is given up', async () => {
    const { state, turn } = turnLike();
    const heldDuring: boolean[] = [];

    await runTransaction(
      owner,
      'main',
      async () => {
        heldDuring.push(state.held);
        await afterCommit(() => void heldDuring.push(state.held));
      },
      turn,
    );
    await runTransaction(
      owner,
      'main',
      async () => {
        heldDuring.push(state.held);
        await afterRollback(() => void heldDuring.push(state.held));
        throw new Error('rolled back');
      },
      turn,
    ).catch(() => undefined);

    // The transaction holds the turn; the work after it does not.
    expect(heldDuring).toEqual([true, false, true, false]);
  });

  it('still throws the error of after-commit work, after the turn is given up', async () => {
    const { state, turn } = turnLike();
    const rejection = runTransaction(owner, 'main', () => afterCommit(() => Promise.reject(new Error('hook failed'))), turn);
    await expect(rejection).rejects.toThrow('hook failed');
    expect(state.held).toBe(false);
  });
});
