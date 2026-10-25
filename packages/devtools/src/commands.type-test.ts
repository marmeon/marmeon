// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `DevtoolsClearCommand` is not exported
import type { DevtoolsClearCommand } from './index.ts';

// @ts-expect-error — `DevtoolsPruneCommand` is not exported
import type { DevtoolsPruneCommand } from './index.ts';

export type Moved = [DevtoolsClearCommand, DevtoolsPruneCommand];
