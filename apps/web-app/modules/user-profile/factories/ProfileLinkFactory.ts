import { defineFactory } from '@bespokecore/database';
import { UserFactory } from '#modules/auth';

export const ProfileLinkFactory = defineFactory('profile_links', ({ sequence, factory }) => ({
  user_id: factory(UserFactory),
  label: `Link ${sequence}`,
  url: `https://example.com/${sequence}`,
}));
