// What the options of `serveFile()` are called — checked by `tsc` (pnpm build / typecheck), never run.
import type { ServeFileOptions } from './index.ts';
// @ts-expect-error — `ServeFileOptions` belongs to `serveFile()`; `ServeOptions` is not exported
import type { ServeOptions } from './index.ts';

export type Serve = [ServeFileOptions, ServeOptions];
