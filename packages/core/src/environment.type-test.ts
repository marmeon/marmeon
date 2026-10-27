// What the launcher checks is not on the public `environment` — checked by `tsc` (pnpm build / typecheck), never run.
import { environment, type NodeEnvironmentName } from './environment.ts';

// @ts-expect-error — `problem` belongs to the framework's own launcher
export const problem = environment.problem;
// @ts-expect-error — `check` belongs to the framework's own launcher
export const check = environment.check;
// @ts-expect-error — `fromDotEnv` belongs to the framework's own launcher
export const fromDotEnv = environment.fromDotEnv;
// @ts-expect-error — `dotEnvDevelopmentWarning` belongs to the framework's own launcher
export const warning = environment.dotEnvDevelopmentWarning;

// @ts-expect-error — `staging` is not a `NODE_ENV` Node knows: a staging server is `production` with `APP_ENV=staging`
export const staging: NodeEnvironmentName = 'staging';
