import { defineModule } from '@marmeon/core';
import type { Generated } from '@marmeon/database';

export interface GuardedTables {
  audit_logs: { id: Generated<number>; entry: string };
  orders: { id: Generated<number> };
  order_trail: { id: Generated<number>; order_id: number };
}

/** An append-only audit log: a trigger refuses TRUNCATE, UPDATE and DELETE on it (SQLite: DELETE). */
export const guarded = defineModule({ name: 'guarded', migrations: new URL('./guarded-migrations/', import.meta.url) });
