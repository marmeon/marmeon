// What only the core itself uses is not exported — checked by `tsc` (pnpm build / typecheck), never run.
import type { Container } from './index.ts';
// @ts-expect-error — `InjectionWarning` is not exported
import type { InjectionWarning } from './index.ts';
// @ts-expect-error — `readEnvFile` is not exported
import type { readEnvFile } from './index.ts';
// @ts-expect-error — `missingListenerQueue` is not exported
import type { missingListenerQueue } from './index.ts';
// @ts-expect-error — the environment entry does not export `readEnvFile` either
import type { readEnvFile as fromEnvironment } from './environment.ts';

export type Moved = [Container, InjectionWarning, typeof readEnvFile, typeof missingListenerQueue, typeof fromEnvironment];
