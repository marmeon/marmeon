// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `MigrateCommand` is not exported
import type { MigrateCommand } from './index.ts';

// @ts-expect-error — `MigrateFreshCommand` is not exported
import type { MigrateFreshCommand } from './index.ts';

// @ts-expect-error — `PublishCommand` is not exported
import type { PublishCommand } from './index.ts';

export type Moved = [MigrateCommand, MigrateFreshCommand, PublishCommand];
