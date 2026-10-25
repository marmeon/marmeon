// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `ScheduleRunCommand` is not exported
import type { ScheduleRunCommand } from './index.ts';

// @ts-expect-error — `ScheduleWorkCommand` is not exported
import type { ScheduleWorkCommand } from './index.ts';

export type Moved = [ScheduleRunCommand, ScheduleWorkCommand];
