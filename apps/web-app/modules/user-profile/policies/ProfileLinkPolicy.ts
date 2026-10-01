import { deny, type AuthUser } from '@bespokecore/auth';
import type { Row } from '@bespokecore/database';

export class ProfileLinkPolicy {
  /** Remove a link: only from your own profile. (The route already looks the link up within its user — no IDOR either way.) */
  delete(user: AuthUser, link: Row<'profile_links'>) {
    return link.user_id === user.id || deny('You can only change your own profile.');
  }
}
