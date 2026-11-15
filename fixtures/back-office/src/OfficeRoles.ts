import { token } from '@marmeon/core';
import type { OfficeRole } from './OfficeUser.ts';

/**
 * Who tells the role of an editor, by mode: the table of the back office's own editors, or the app's {@link OfficeAccess}. The provider binds it
 * once, so the policy and the listener never choose a mode themselves. Not exported: the app binds `OfficeAccess`, never this.
 */
export interface OfficeRoles {
  roleOf(userId: number): OfficeRole | undefined | Promise<OfficeRole | undefined>;
}
export const OfficeRoles = token<OfficeRoles>('OfficeRoles');
