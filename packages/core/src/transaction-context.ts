import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The ambient transaction context (E107): which database transaction the current async call chain runs in.
 *
 * A transaction is entered ONLY by an explicit `transaction(callback)` (`connections.transaction`,
 * `repository.transaction` in @bespokecore/database) and lasts exactly as long as its callback. Everything awaited
 * inside joins it — repositories, the database queue driver, in-process event listeners — without passing the
 * transaction around. AsyncLocalStorage follows one async call chain: a transaction never reaches another request, job
 * or test running at the same time.
 *
 * The rules that keep this door narrow:
 * - **Loud, never silent:** work started inside a transaction that runs after it finished (an un-awaited promise, a
 *   timer) throws {@link TransactionFinishedError} — it is never quietly sent to the database outside the transaction.
 * - **Framework boundaries cut the context** ({@link outsideTransaction}): work after the response, jobs, the worker —
 *   they never run inside the transaction that happened to be open when they were registered.
 * - **After the commit** ({@link afterCommit}): work that must not happen for a rolled-back transaction (a job on a
 *   queue outside the database, a mail) waits for the outermost commit and is dropped on a rollback.
 *
 * This module is the context only; the database package binds connections to it.
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

  /** @internal — marks the transaction finished and hands over its after-commit work (the caller drops it after a rollback). */
  finish(state: 'committed' | 'rolled back'): (() => unknown)[] {
    this.#state = state;
    const work = this.#afterCommit;
    this.#afterCommit = [];
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

// The third deliberate piece of ambient state, next to the request/job context (E3) and logging: the transaction a call
// chain runs in (E107). Context only — which transaction — never services or data.
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
 * @internal — for database drivers: runs `body` as a new transaction of `owner` (nested in the current one, if any),
 * and finishes it with `body`'s outcome. After the outermost commit its after-commit work runs, outside of any
 * transaction; a nested commit hands it to the transaction around it.
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
    // Rolled back: its after-commit work is dropped — it was for data that never existed.
    frame.finish('rolled back');
    throw error;
  }
  const work = frame.finish('committed');
  if (work.length === 0) return result;
  // Committed into the transaction around it: the work waits for that one (and is dropped if it rolls back).
  if (parent?.open) {
    parent.addAfterCommit(work);
    return result;
  }
  await runAfterCommit(work);
  return result;
}

/** Runs after-commit work one after the other, outside of any transaction; all of it runs, then the first error is thrown. */
async function runAfterCommit(work: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const fn of work) {
    try {
      await outsideTransaction(fn);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} pieces of after-commit work failed (the transaction is committed).`);
}

/**
 * Runs `fn` once the current transaction has committed — the outermost one, when transactions are nested — outside of
 * any transaction; never, if it rolls back. Outside a transaction it runs now (and the returned promise settles with
 * it). Inside one, the returned promise resolves at once; an error of `fn` is thrown by the `transaction()` call that
 * committed (its data is committed by then).
 *
 * For work that must not happen for data that never existed: a job on a queue outside the database, a mail, a cache
 * write. (The database queue needs none of this — its jobs are rows in the same transaction.)
 *
 * ```ts
 * await connections.transaction(async () => {
 *   const user = await users.insert({ … });
 *   await afterCommit(() => mailer.send(new WelcomeMail(user)));
 * });
 * ```
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
 * Runs `fn` outside of the current transaction: its database work goes to the connection directly and is kept even
 * when the transaction rolls back — a failed-attempt counter, a security log entry:
 *
 * ```ts
 * await connections.transaction(async () => {
 *   if (!(await this.#codes.consume(user, code))) {
 *     await outsideTransaction(() => this.#attempts.recordFailure(user.id));   // survives the rollback below
 *     throw new InvalidCodeError();
 *   }
 *   …
 * });
 * ```
 *
 * It is also how the framework cuts the context at its own boundaries (work after the response, jobs, the worker): what
 * runs there never joins the transaction that was open when it was registered.
 *
 * On a connection with a single physical connection — SQLite, or a test's isolated connection — work outside an open
 * transaction cannot run until it ends; there it fails at once with a {@link TransactionError} instead of waiting
 * forever. Record such things after the transaction instead (catch, record, rethrow).
 */
export function outsideTransaction<R>(fn: () => R): R {
  const context = storage.getStore();
  if (!context) return fn();
  const left = context.frame ? [context.frame, ...context.left] : context.left;
  return storage.run({ frame: undefined, left }, fn);
}
