import type { StandardSchemaV1 } from '@marmeon/router';
import type { FilterOption } from './define.ts';

// Kept out of define.ts, which loads the routes, which load the tables: the tables need these two at run time and define.ts must not be loaded for them.

/**
 * @internal — the values and labels of a list, rebuilt from the named fields only (an extra field of an option, such as a spread
 * row, never reaches the props). A label is the value when none is given.
 */
export function normalizeOptions(label: string, options: unknown): { readonly values: string[]; readonly labels: string[] } {
  const values: string[] = [];
  const labels: string[] = [];
  const fail = () => new TypeError(`${label}: strings, or { value, label } objects, of 1 to 100 characters.`);
  if (!Array.isArray(options)) throw fail();
  for (const option of options as unknown[]) {
    const value = typeof option === 'string' ? option : typeof option === 'object' && option !== null ? (option as FilterOption).value : undefined;
    const text = typeof option === 'string' ? option : (option as FilterOption).label;
    if (typeof value !== 'string' || value.length === 0 || value.length > 100 || typeof text !== 'string') throw fail();
    values.push(value);
    labels.push(text);
  }
  return { values, labels };
}

/** @internal — whether `value` is a Standard Schema (ArkType's are callable, so a function alone does not say "factory"). */
export function isSchema(value: unknown): value is StandardSchemaV1 {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && '~standard' in value;
}
