import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One open database transaction of the ambient context: entered only by an explicit `transaction(callback)`, it follows that
 * call chain and nothing else. Work started inside that runs after it finished throws {@link TransactionFinishedError} —
 * never quietly outside the transaction. The database package binds connections to it; see docs/transactions.md#introduction.
 */
export class TransactionFrame {
  /** The transaction around this one (a savepoint's transaction, or one on another connection). */
  readonly parent: TransactionFrame | undefined;
  /** Who opened it — the database driver of its connection. */
  readonly owner: object;
  /** For messages: the connection's name. */
  readonly label: string;
  /** The owner's handle on the transaction (the database connection), set when it begins. */
  resource: unknown;
  #state: 'open' | 'committed' | 'rolled back' = 'open';
  #afterCommit: (() => unknown)[] = [];
  #afterRollback: (() => unknown)[] = [];
  /** A transaction opened inside this one on the same connection (a savepoint), while it has not finished. */
  #child: TransactionFrame | undefined;

  constructor(owner: object, label: string, parent: TransactionFrame | undefined) {
    this.owner = owner;
    this.label = label;
    this.parent = parent;
  }

  get state(): 'open' | 'committed' | 'rolled back' {
    return this.#state;
  }

  get open(): boolean {
    return this.#state === 'open';
  }

  /** @internal */
  enterChild(child: TransactionFrame): void {
    if (this.#child && this.#child.open) {
      throw new TransactionError(
        `Two transactions were opened at the same time inside one transaction on "${this.label}" (Promise.all over transaction() calls?) — ` +
          'they would share one connection and interleave their savepoints. Run them one after the other.',
      );
    }
    this.#child = child;
  }

  /** @internal */
  addAfterCommit(work: (() => unknown)[]): void {
    this.#afterCommit.push(...work);
  }

  /** @internal */
  addAfterRollback(work: (() => unknown)[]): void {
    this.#afterRollback.push(...work);
  }

  /**
   * @internal — marks the transaction finished and hands over its after-commit and after-rollback work (the caller runs
   * one list, hands both to the transaction around it, or drops them — see {@link runTransaction}).
   */
  finish(state: 'committed' | 'rolled back'): { readonly commit: (() => unknown)[]; readonly rollback: (() => unknown)[] } {
    this.#state = state;
    const work = { commit: this.#afterCommit, rollback: this.#afterRollback };
    this.#afterCommit = [];
    this.#afterRollback = [];
    return work;
  }
}

/** A transaction cannot be used the way it was asked to (see the message). */
export class TransactionError extends Error {
  override name = 'TransactionError';
}

/** Work started inside a transaction ran after it finished — the database refuses it instead of running it outside. */
export class TransactionFinishedError extends TransactionError {
  override name = 'TransactionFinishedError';
  readonly connection: string;

  constructor(frame: TransactionFrame) {
    super(
      `This work was started inside transaction() on "${frame.label}" but ran after that transaction was ${frame.state} — ` +
        'await it inside the callback, or wrap it in outsideTransaction() if it should run on its own.',
    );
    this.connection = frame.label;
  }
}

interface Context {
  /** The innermost transaction of this call chain. */
  readonly frame: TransactionFrame | undefined;
  /** Transactions left by outsideTransaction() — still open around this call chain, but not its context. */
  readonly left: readonly TransactionFrame[];
}

// The third deliberate piece of ambient state, next to the request/job context and logging: the transaction a call
// chain runs in. Context only — which transaction — never services or data.
const storage = new AsyncLocalStorage<Context>();

/**
 * The innermost transaction of the current call chain, or `undefined` outside of one. Throws
 * {@link TransactionFinishedError} when the call chain was started inside a transaction that has finished since — a
 * caller consulting the context must never quietly act as if there were none.
 */
export function currentTransaction(): TransactionFrame | undefined {
  const frame = storage.getStore()?.frame;
  if (frame && !frame.open) throw new TransactionFinishedError(frame);
  return frame;
}

/** Whether the current call chain runs inside a transaction (throws like {@link currentTransaction} when that one finished). */
export function inTransaction(): boolean {
  return currentTransaction() !== undefined;
}

/** The innermost transaction of `owner` in the current call chain (throws like {@link currentTransaction}). */
export function transactionOf(owner: object): TransactionFrame | undefined {
  for (let frame = currentTransaction(); frame; frame = frame.parent) if (frame.owner === owner) return frame;
  return undefined;
}

/** An open transaction of `owner` that {@link outsideTransaction} stepped out of — the call chain still waits for it. */
export function leftTransactionOf(owner: object): TransactionFrame | undefined {
  for (const left of storage.getStore()?.left ?? []) {
    for (let frame: TransactionFrame | undefined = left; frame; frame = frame.parent) if (frame.owner === owner && frame.open) return frame;
  }
  return undefined;
}

/**
 * An open transaction of `owner` that the current call chain is in, or stepped out of with {@link outsideTransaction} —
 * one that holds the owner's connection while this call chain runs. Unlike {@link transactionOf} it never throws: a
 * finished transaction holds nothing. For connections that must never join a transaction.
 */
export function openTransactionOf(owner: object): TransactionFrame | undefined {
  const context = storage.getStore();
  if (!context) return undefined;
  for (const start of context.frame ? [context.frame, ...context.left] : context.left) {
    for (let frame: TransactionFrame | undefined = start; frame; frame = frame.parent) if (frame.owner === owner && frame.open) return frame;
  }
  return undefined;
}

/**
 * @internal — for database drivers: runs `body` as a new transaction of `owner` (nested in the current one, if any),
 * and finishes it with `body`'s outcome:
 *
 * - **Committed:** nested, its after-commit and after-rollback work go to the transaction around it (both still depend
 *   on that one); outermost, the after-commit work runs — outside of any transaction — and the after-rollback work is
 *   dropped.
 * - **Rolled back** (outermost or a savepoint): the after-commit work is dropped, and the after-rollback work runs at
 *   once — outside of any transaction — because what it was for is undone for good, whatever the transactions around it
 *   do. Its errors do not hide the error that rolled the transaction back (see {@link afterRollback}).
 */
export async function runTransaction<R>(owner: object, label: string, body: (frame: TransactionFrame) => Promise<R>): Promise<R> {
  const parent = currentTransaction();
  const frame = new TransactionFrame(owner, label, parent);
  // Nested on the same connection: a savepoint — and only one at a time.
  transactionOf(owner)?.enterChild(frame);
  const context = storage.getStore();
  let result: R;
  try {
    result = await storage.run({ frame, left: context?.left ?? [] }, () => body(frame));
  } catch (error) {
    // Rolled back: its after-commit work is dropped — it was for data that never existed — and its after-rollback work
    // runs now: what it cleans up after is gone, even if a transaction around this one still commits.
    const { rollback } = frame.finish('rolled back');
    const failures = await runOutside(rollback);
    if (failures.length === 0) throw error;
    const cause = failures.length === 1 ? failures[0] : new AggregateError(failures, `${failures.length} pieces of after-rollback work failed.`);
    throw new SuppressedError(cause, error, `After-rollback work failed (the transaction on "${label}" is rolled back): ${messageOf(cause)}`);
  }
  const { commit, rollback } = frame.finish('committed');
  // Committed into the transaction around it: both kinds of work wait for that one.
  if (parent?.open) {
    if (commit.length > 0) parent.addAfterCommit(commit);
    if (rollback.length > 0) parent.addAfterRollback(rollback);
    return result;
  }
  const failures = await runOutside(commit);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} pieces of after-commit work failed (the transaction is committed).`);
  return result;
}

/** Runs work one after the other, outside of any transaction; all of it runs. Returns the errors. */
async function runOutside(work: readonly (() => unknown)[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const fn of work) {
    try {
      await outsideTransaction(fn);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `fn` once the outermost transaction has committed, outside of any transaction; never after a rollback, and at once
 * outside a transaction. An error of `fn` is thrown by the `transaction()` call that committed (the data is committed by
 * then). See docs/transactions.md#after-the-commit.
 */
export async function afterCommit(fn: () => unknown): Promise<void> {
  const frame = currentTransaction();
  if (!frame) {
    await fn();
    return;
  }
  frame.addAfterCommit([fn]);
}

/**
 * Runs `fn` right after the current (innermost) transaction rolls back, outside of any transaction; never after a commit or
 * outside a transaction — to undo work done outside it on its behalf. An error of `fn` does not hide the rollback's:
 * `transaction()` throws a `SuppressedError`. See docs/transactions.md#after-a-rollback.
 */
export async function afterRollback(fn: () => unknown): Promise<void> {
  currentTransaction()?.addAfterRollback([fn]);
}

/**
 * Runs `fn` outside of the current transaction: its database work is kept even when the transaction rolls back (a
 * failed-attempt counter). The framework cuts the context the same way at its boundaries (work after the response, jobs).
 * On a single physical connection (SQLite, a test's isolated connection) such work throws a {@link TransactionError} at once
 * instead of waiting forever. See docs/transactions.md#outside-the-transaction.
 */
export function outsideTransaction<R>(fn: () => R): R {
  const context = storage.getStore();
  if (!context) return fn();
  const left = context.frame ? [context.frame, ...context.left] : context.left;
  return storage.run({ frame: undefined, left }, fn);
}
