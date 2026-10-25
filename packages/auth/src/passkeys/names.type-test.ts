// What the passkey setup error is called — checked by `tsc` (pnpm build / typecheck), never run.
import { PasskeySetupError } from './index.ts';
// @ts-expect-error — `PasskeySetupError` is thrown for a bad setup; `PasskeyConfigError` is not exported
import { PasskeyConfigError } from './index.ts';

export const errors = [PasskeySetupError, PasskeyConfigError];
