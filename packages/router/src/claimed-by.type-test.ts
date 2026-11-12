// What `Router.claimedBy()` takes and answers: checked by `tsc`, never run.
import { Router, type PathClaim } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <_T extends true>(): void => {};

declare const router: Router;

is<Equal<ReturnType<typeof router.claimedBy>, PathClaim | undefined>>();

// @ts-expect-error a path is a string
router.claimedBy(1);
// @ts-expect-error a path is a string
router.claimedBy(undefined);
