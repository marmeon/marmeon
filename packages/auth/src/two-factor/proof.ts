import { Session } from '@marmeon/session';
import { AUTH_SESSION_KEYS } from '../auth.ts';

/**
 * How long a proven second factor counts for a change to an account's factors, in seconds: the same fifteen minutes as the
 * sudo window. A constant, not a setting: `confirmedSecondFactor()` and the methods that change factors must see the same number.
 */
export const FACTOR_CHANGE_MAX_AGE = 900;

/** Whether this session proved a second factor within the last `seconds`, counted up to `nowSeconds` (the app's clock). A missing, malformed or future time counts as not proven. */
export function secondFactorProvenWithin(session: Session, seconds: number, nowSeconds: number): boolean {
  const at = session.started ? session.get(AUTH_SESSION_KEYS.twoFactorAt) : undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  const age = nowSeconds - at;
  return age >= 0 && age <= seconds;
}
