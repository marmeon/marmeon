// What the client's address and browser are called — checked by `tsc` (pnpm build / typecheck), never run.
import type { ClientInfo } from './index.ts';
// @ts-expect-error — `ClientInfo` describes the sender of the request; `RequestInfo` is not exported
import type { RequestInfo } from './index.ts';
// @ts-expect-error — NO_REQUEST_INFO is not exported; NO_CLIENT_INFO is
import { NO_REQUEST_INFO } from './index.ts';

export type Client = [ClientInfo, RequestInfo, typeof NO_REQUEST_INFO];
