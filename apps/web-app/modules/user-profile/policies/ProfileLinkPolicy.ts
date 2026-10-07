import { deny, type AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

/** What the policy needs of a link: whose it is. A bound row has it, and so has a link of the profile's read model. */
type OwnedLink = Pick<Row<'profile_links'>, 'user_id'>;

export class ProfileLinkPolicy {
  /** Remove a link: only from your own profile. (The route already looks the link up within its user — no IDOR either way.) */
  delete(user: AuthUser, link: OwnedLink) {
    return link.user_id === user.id || deny('user-profile.validation.own_profile') /* a key: the exception handler translates it */;
  }
}
