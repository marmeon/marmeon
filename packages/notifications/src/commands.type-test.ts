// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `PruneNotificationsCommand` is not exported
import type { PruneNotificationsCommand } from './index.ts';

// @ts-expect-error — `MakeNotificationsTableCommand` is not exported
import type { MakeNotificationsTableCommand } from './index.ts';

export type Moved = [PruneNotificationsCommand, MakeNotificationsTableCommand];
