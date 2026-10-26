// ExtractParams reads a parameter where the router does: after a `/`, never in the middle of a segment — checked by `tsc`, never run.
import type { ExtractParams } from './types.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <_T extends true>(): void => {};

is<Equal<ExtractParams<'/teams/:team/users/:id?'>, { team: string } & { id?: string }>>();
is<Equal<ExtractParams<'/archive/:year{[0-9]{4}}'>, { year: string }>>();
is<Equal<keyof ExtractParams<'/v:version/about'>, never>>();
is<Equal<keyof ExtractParams<'/files/v1:x'>, never>>();
is<Equal<ExtractParams<':id'>, { id: string }>>();
is<Equal<ExtractParams<':team/members/:member?'>, { team: string } & { member?: string }>>();
