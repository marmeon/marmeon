import { token } from '@marmeon/core';
import type { OfficeRole } from './OfficeUser.ts';

/**
 * Which role the app gives one of its users in the back office, for the mode that serves the app's users (`BACK_OFFICE_USERS=app`). The app
 * binds it; the package never decides for it, so an app that binds nothing admits nobody. The own mode never asks it: its editors are
 * another set of accounts whose ids mean other people.
 */
export interface OfficeAccess {
  roleOf(userId: number): OfficeRole | undefined | Promise<OfficeRole | undefined>;
}
export const OfficeAccess = token<OfficeAccess>('OfficeAccess');
