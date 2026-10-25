// What a stored cache entry is called — checked by `tsc` (pnpm build / typecheck), never run.
import type { CacheEntry } from './index.ts';
// @ts-expect-error — `CacheEntry` is what a store keeps; `Entry` is not exported
import type { Entry } from './index.ts';

export type Stored = [CacheEntry, Entry];
