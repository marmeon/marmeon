import { classesOf } from './injection/analyze.ts';
import { parseSync } from './oxc.ts';

/** A `static <key> = '<string>'` field of a class, as written in its source. */
export interface StaticName {
  readonly className: string;
  readonly key: string;
  readonly value: string;
  /** 1-based line of the field. */
  readonly line: number;
}

type Node = { type: string; start: number; end: number; [key: string]: any };

/**
 * The classes in `source` with a literal `static` field named in `keys` (`static job = 'billing.send'`), found by parsing —
 * the file is never imported. Computed keys and values that are not string literals are ignored; a file that does not
 * parse yields nothing.
 */
export function staticNames(source: string, filename: string, keys: readonly string[]): StaticName[] {
  if (!keys.some((key) => source.includes(key))) return [];
  const { program, errors } = parseSync(filename, source);
  if (errors.length > 0) return [];
  const found: StaticName[] = [];
  for (const { node, name } of classesOf(program as Node)) {
    for (const member of node.body.body as Node[]) {
      if (member.type !== 'PropertyDefinition' || !member.static || member.computed || member.key?.type !== 'Identifier') continue;
      const key: string = member.key.name;
      const value = literal(member.value);
      if (!keys.includes(key) || value === undefined) continue;
      found.push({ className: name, key, value, line: source.slice(0, member.start).split('\n').length });
    }
  }
  return found;
}

function literal(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return literal(node.expression);
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}
