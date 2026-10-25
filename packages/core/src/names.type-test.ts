// What the request, job and task context types are called — checked by `tsc` (pnpm build / typecheck), never run.
import type { CurrentJob, CurrentRequest, CurrentTask } from './index.ts';
// @ts-expect-error — `CurrentRequest` is what `currentRequest()` returns; `RequestInfo` is not exported
import type { RequestInfo } from './index.ts';
// @ts-expect-error — `CurrentJob` is what `currentJob()` returns; `JobInfo` is not exported
import type { JobInfo } from './index.ts';
// @ts-expect-error — `CurrentTask` is what `currentTask()` returns; `TaskInfo` is not exported
import type { TaskInfo } from './index.ts';

export type Current = [CurrentRequest, CurrentJob, CurrentTask, RequestInfo, JobInfo, TaskInfo];
