import { defineFactory } from '@bespokecore/database';

/**
 * `password`, hashed once — at the test costs of `.env.test`, so factory users sign in without
 * a rehash in tests. Like Laravel's former factory constant: hashing per row would make every
 * `count(50)` cost 50 hashes. (The seeder hashes with the configured costs instead.)
 */
export const FACTORY_PASSWORD_HASH = '$argon2id$v=19$m=1024,t=1,p=1$4Xhubcoo37TNJTsjeD4YIg$tLK1IR1zuYLJNCVRYJaBxiXR+EuI6aAXP5Wt1Ha2xlQ';

export const UserFactory = defineFactory(
  'users',
  ({ sequence }) => ({
    name: `User ${sequence}`,
    email: `user${sequence}@example.com`,
    password: FACTORY_PASSWORD_HASH,
    email_verified_at: new Date().toISOString(),
  }),
  { states: { unverified: { email_verified_at: null } } },
);
