// What the column of a repository is called — checked by `tsc` (pnpm build / typecheck), never run.
import type { RepositoryColumnOf } from './index.ts';
// @ts-expect-error — `RepositoryColumnOf` is the column a repository rule takes; `ColumnOf` is not exported
import type { ColumnOf } from './index.ts';

export type Column = [RepositoryColumnOf<never>, ColumnOf<never>];
