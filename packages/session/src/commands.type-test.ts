// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `PruneSessionsCommand` is not exported
import type { PruneSessionsCommand } from './index.ts';

// @ts-expect-error — `MakeSessionTableCommand` is not exported
import type { MakeSessionTableCommand } from './index.ts';

export type Moved = [PruneSessionsCommand, MakeSessionTableCommand];
