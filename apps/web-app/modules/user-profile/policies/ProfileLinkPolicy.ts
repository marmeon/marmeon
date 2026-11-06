import { deny, type AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

/** What the policy needs of a link: whose it is. A bound row has it, and so has a link read for the profile page. */
type OwnedLink = Pick<Row<'profile_links'>, 'user_id'>;

export class ProfileLinkPolicy {
  /** Remove a link: only from your own profile. (The route already looks the link up within its user, so this is a second check.) */
  delete(user: AuthUser, link: OwnedLink) {
    // The argument is a translation key: the exception handler turns it into the message.
    return link.user_id === user.id || deny('user-profile.validation.own_profile');
  }
}
