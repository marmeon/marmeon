// Type guarantees of the client's names — checked by `tsc` (pnpm build / typecheck), never run.
import type { ActionError, ClientAction, ClientRouter, VisitError } from './index.ts';
import { useRouter } from './index.ts';
// @ts-expect-error — renamed to `ActionError`
import type { ActionException } from './index.ts';
// @ts-expect-error — renamed to `VisitError`
import type { VisitException } from './index.ts';
// @ts-expect-error — the hook's result is `ClientRouter`
import type { Router } from './index.ts';
// @ts-expect-error — the hook's result is `ClientAction`
import type { Action } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
  return undefined;
}

export function clientNames() {
  assert<Equal<ReturnType<typeof useRouter>, ClientRouter>>();
  const action: ClientAction<'x'> | undefined = undefined;
  const failed: VisitError | undefined = undefined;
  const outcome: ActionError | undefined = undefined;
  return [failed, outcome, action];
}
export type Unused = [ActionException, VisitException, Router, Action];
