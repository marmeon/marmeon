import type { Row } from '@bespokecore/database';

/** A user as stored — typed by the migration (bootstrap/database.d.ts). */
export type User = Row<'users'>;
