// Type guarantees of the client core's error names — checked by `tsc` (pnpm build / typecheck), never run.
import type { ActionError, VisitError } from './index.ts';
import type { ActionError as AdapterActionError, VisitError as AdapterVisitError } from './adapter.ts';
// @ts-expect-error — renamed to `ActionError`
import type { ActionException } from './index.ts';
// @ts-expect-error — renamed to `VisitError`
import type { VisitException } from './index.ts';
// @ts-expect-error — renamed to `ActionError`
import type { ActionException as AdapterActionException } from './adapter.ts';
// @ts-expect-error — renamed to `VisitError`
import type { VisitException as AdapterVisitException } from './adapter.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
  return undefined;
}

export function clientErrorNames() {
  assert<Equal<ActionError, AdapterActionError>>();
  assert<Equal<VisitError, AdapterVisitError>>();
}
export type Unused = [ActionException, VisitException, AdapterActionException, AdapterVisitException];
