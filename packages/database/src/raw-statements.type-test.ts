// What `schema.raw()` takes per driver — checked by `tsc` (pnpm build / typecheck), never run.
import { sql } from 'kysely';
import type { RawStatements } from './schema/plan.ts';

// `null` on a driver says on purpose that there is nothing to run there.
export const none: RawStatements = { sqlite: sql`select 1`, pgsql: sql`select 1`, mysql: null };
export const some: RawStatements = { mysql: sql`select 1` };

// @ts-expect-error — a statement is a raw builder or null, not text
export const text: RawStatements = { mysql: 'select 1' };
