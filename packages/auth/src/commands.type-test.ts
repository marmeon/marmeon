// The command classes are not exported: a command is run by its name (`marmeon <name>`, `app.command('<name>')`) — checked by `tsc`, never run.

// @ts-expect-error — `EndSessionsCommand` is not exported
import type { EndSessionsCommand } from './index.ts';

// @ts-expect-error — `ResetTwoFactorCommand` is not exported
import type { ResetTwoFactorCommand } from './index.ts';

// @ts-expect-error — `PruneTokensCommand` is not exported
import type { PruneTokensCommand } from './index.ts';

export type Moved = [EndSessionsCommand, ResetTwoFactorCommand, PruneTokensCommand];
