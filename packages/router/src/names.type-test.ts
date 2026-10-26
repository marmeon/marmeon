// What the dispatch types are not called in the public entry — checked by `tsc` (pnpm build / typecheck), never run.
import type { DispatchOptions, ResponseFactory } from './internal.ts';
// @ts-expect-error — `DispatchOptions` belongs to `@marmeon/router/internal`
import type { DispatchOptions as PublicDispatchOptions } from './index.ts';
// @ts-expect-error — `ResponseFactory` belongs to `@marmeon/router/internal`
import type { ResponseFactory as PublicResponseFactory } from './index.ts';

export type Dispatch = [DispatchOptions, ResponseFactory, PublicDispatchOptions, PublicResponseFactory];
