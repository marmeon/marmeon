// What the dispatch types are not called in the public entry — checked by `tsc` (pnpm build / typecheck), never run.
import type { DispatchInput, DispatchOptions, ResponseFactory } from './internal.ts';
// @ts-expect-error — `DispatchInput` belongs to `@marmeon/router/internal`
import type { DispatchInput as PublicDispatchInput } from './index.ts';
// @ts-expect-error — `DispatchOptions` belongs to `@marmeon/router/internal`
import type { DispatchOptions as PublicDispatchOptions } from './index.ts';
// @ts-expect-error — `ResponseFactory` belongs to `@marmeon/router/internal`
import type { ResponseFactory as PublicResponseFactory } from './index.ts';

export type Dispatch = [DispatchInput, DispatchOptions, ResponseFactory, PublicDispatchInput, PublicDispatchOptions, PublicResponseFactory];
