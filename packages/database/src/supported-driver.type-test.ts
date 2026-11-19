// What `requireDriver()` promises its callers — checked by `tsc` (pnpm build / typecheck), never run.
import { requireDriver } from './supported-driver.ts';

const feature = { what: 'A feature' };

// A literal list gives the union of its names.
const narrowed: 'sqlite' | 'pgsql' = requireDriver('sqlite', ['sqlite', 'pgsql'] as const, feature);
const alone: 'pgsql' = requireDriver('pgsql', ['pgsql'], feature);

// A list that is only `string[]` gives a driver name, not a string.
const wide: ('sqlite' | 'pgsql')[] = ['sqlite'];
const fromVariable = requireDriver('sqlite', wide, feature);
const named: 'sqlite' | 'pgsql' = fromVariable;
// @ts-expect-error — `'sqlite' | 'pgsql'` is not `'sqlite'`
const tooNarrow: 'sqlite' = fromVariable;

// Every driver the connection types name can be listed.
const withMysql: 'sqlite' | 'mysql' = requireDriver('mysql', ['sqlite', 'mysql'] as const, feature);

// A name that is no driver does not compile in the list.
// @ts-expect-error — `'oracle'` is not a driver this package knows
requireDriver('oracle', ['sqlite', 'oracle'], feature);
// @ts-expect-error — a typo in the list
requireDriver('sqlite', ['sqlite', 'pgsq'], feature);
// @ts-expect-error — a list of plain strings
requireDriver('sqlite', [] as string[], feature);

export type Checked = [typeof narrowed, typeof alone, typeof named, typeof tooNarrow, typeof withMysql];
