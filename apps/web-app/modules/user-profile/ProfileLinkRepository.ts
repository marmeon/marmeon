import { Repository } from '@bespokecore/database';

/** The links on people's profiles — this module's own table. Bound scoped to its user in the routes. */
export class ProfileLinkRepository extends Repository<'profile_links'> {
  static table = 'profile_links' as const;
  static timestamps = true;
}
