// The type generator lives in `@marmeon/database/internal` — checked by `tsc` (pnpm build / typecheck), never run.
import type { Migrator } from './index.ts';
// @ts-expect-error — `TypeGenerator` is in `@marmeon/database/internal`
import type { TypeGenerator } from './index.ts';
// @ts-expect-error — `Rendered` is in `@marmeon/database/internal`
import type { Rendered } from './index.ts';

export type Moved = [Migrator, TypeGenerator, Rendered];
