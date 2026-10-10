import type { Secret } from '../secrets.ts';
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
  // The relations fixture (`migrations/relations`).
  posts: {
    id: Generated<number>;
    author_id: number;
    editor_id: number | null;
    title: string;
    featured: Generated<boolean>;
    rating: Generated<Decimal>;
    published_at: Timestamp | null;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
  };
  comments: {
    id: Generated<number>;
    post_id: number;
    user_id: number;
    body: string;
    approved: Generated<boolean>;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
    deleted_at: Timestamp | null;
  };
  tags: {
    id: Generated<number>;
    slug: string;
  };
  post_tag: {
    post_id: number;
    tag_id: number;
  };
  post_stats: {
    post_id: number;
    views: Generated<number>;
  };
  categories: {
    id: Generated<number>;
    name: string;
    parent_id: number | null;
  };
  // `migrations/relations-secrets`: a related table with a secret column.
  api_keys: {
    id: Generated<number>;
    user_id: number;
    name: string;
    token: Secret<string>;
  };
}
