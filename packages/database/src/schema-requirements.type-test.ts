// Type guarantees of the public SchemaRequirements — checked by `tsc` (pnpm build / typecheck), never run.
import type { SchemaRequirements, TableRequirement } from './index.ts';

declare const requirements: SchemaRequirements;

const requirement: TableRequirement = { connection: 'default', table: 'audit_entries', columns: ['id'], secrets: ['payload'], set: 'audit' };
requirements.require(requirement);
requirements.require({ ...requirement, whenPresent: true });

const all: readonly TableRequirement[] = requirements.all();
void all;

// @ts-expect-error — the list is read-only
requirements.all().push(requirement);

// @ts-expect-error — a requirement names the columns the code reads and writes
requirements.require({ connection: 'default', table: 'audit_entries', set: 'audit' });

// @ts-expect-error — and the set its tables belong to
requirements.require({ connection: 'default', table: 'audit_entries', columns: ['id'] });

// @ts-expect-error — `whenPresent` is either true or left out
requirements.require({ ...requirement, whenPresent: false });
