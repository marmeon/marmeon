import { token } from '@marmeon/core';
import type { AuthUser } from '@marmeon/auth';

/** Who may open the area. The app binds it; the package never decides for it, so an app that binds nothing opens nothing. */
export interface StatusAccess {
  allows(user: AuthUser): boolean | Promise<boolean>;
}
export const StatusAccess = token<StatusAccess>('StatusAccess');
