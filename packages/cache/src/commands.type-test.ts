// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `CacheClearCommand` is not exported
import type { CacheClearCommand } from './index.ts';

// @ts-expect-error — `CachePruneCommand` is not exported
import type { CachePruneCommand } from './index.ts';

// @ts-expect-error — `MakeCacheTableCommand` is not exported
import type { MakeCacheTableCommand } from './index.ts';

export type Moved = [CacheClearCommand, CachePruneCommand, MakeCacheTableCommand];
