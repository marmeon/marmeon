import { sql } from 'kysely';

/** The parts of a table name as Kysely sends them: `schema.table` is two identifiers (only the first dot splits, a third part is dropped), a name without a dot is one, untrimmed. */
export function tableParts(name: string): { kind: 'schema' | 'table'; name: string }[] {
  const [node] = (sql.table(name).toOperationNode() as unknown as { parameters: { table: { schema?: { name: string }; identifier: { name: string } } }[] }).parameters;
  const { schema, identifier } = node!.table;
  return [...(schema ? [{ kind: 'schema' as const, name: schema.name }] : []), { kind: 'table' as const, name: identifier.name }];
}
