// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `PruneUploadsCommand` is not exported
import type { PruneUploadsCommand } from './index.ts';

// @ts-expect-error — `MakeUploadsTableCommand` is not exported
import type { MakeUploadsTableCommand } from './index.ts';

export type Moved = [PruneUploadsCommand, MakeUploadsTableCommand];
