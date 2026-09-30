import type { Decimal, Generated, JsonColumn, Timestamp } from '../types.ts';

/** What `db:types` generates for the fixture migrations (see types-gen.test.ts) — for tests that need typed tables. */
export interface FixtureTables {
  users: {
    id: Generated<number>;
    name: string;
    email: string;
    is_admin: Generated<boolean>;
    settings: JsonColumn | null;
    balance: Generated<Decimal>;
    born_on: string | null;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
    deleted_at: Timestamp | null;
  };
  articles: {
    id: Generated<number>;
    user_id: number;
    title: string;
    content: string | null;
    published_at: Timestamp | null;
    slug: string | null;
  };
}
