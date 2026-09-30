import { defineFactory } from '@bespokecore/database';

export const UserFactory = defineFactory('users', ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
  bio: '',
}));
