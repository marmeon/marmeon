// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `QueueWorkCommand` is not exported
import type { QueueWorkCommand } from './index.ts';

// @ts-expect-error — `QueueRetryCommand` is not exported
import type { QueueRetryCommand } from './index.ts';

// @ts-expect-error — `MakeQueueTableCommand` is not exported
import type { MakeQueueTableCommand } from './index.ts';

export type Moved = [QueueWorkCommand, QueueRetryCommand, MakeQueueTableCommand];
