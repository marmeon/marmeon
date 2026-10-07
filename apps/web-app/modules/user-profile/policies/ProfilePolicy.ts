import { deny, type AuthUser } from '@marmeon/auth';

/** Who may do what with a profile. Profiles come as different rows (UserRepository, ProfileDirectory) — the policy needs only the id. */
export class ProfilePolicy {
  /** Edit the profile and its links: only your own. */
  update(user: AuthUser, profile: { readonly id: number }) {
    return user.id === profile.id || deny('user-profile.validation.own_profile') /* a key: the exception handler translates it */;
  }

  /** See the e-mail address: only your own. */
  viewEmail(user: AuthUser, profile: { readonly id: number }) {
    return user.id === profile.id;
  }
}
