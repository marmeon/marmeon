// The machinery of the uploads is not exported — checked by `tsc` (pnpm build / typecheck), never run.
import type { TemporaryUpload } from './index.ts';
// @ts-expect-error — `TemporaryUploads` is not exported
import type { TemporaryUploads } from './index.ts';
// @ts-expect-error — `TargetRequest` is not exported
import type { TargetRequest } from './index.ts';
// @ts-expect-error — `UploadTarget` is not exported
import type { UploadTarget } from './index.ts';
// @ts-expect-error — `UploadSource` is not exported
import type { UploadSource } from './index.ts';
// @ts-expect-error — `UploadsOptions` is not exported
import type { UploadsOptions } from './index.ts';

export type Moved = [TemporaryUpload, TemporaryUploads, TargetRequest, UploadTarget, UploadSource, UploadsOptions];
