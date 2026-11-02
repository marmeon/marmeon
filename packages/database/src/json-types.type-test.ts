// Type guarantees of a JSON column's value type (`JsonTypes`) — checked by `tsc` (pnpm build / typecheck), never run. The message of a
// declared type that is no JSON is quoted in the comment.
import { expectTypeOf } from 'vitest';
import { Repository, type Connection, type Generated, type Json, type JsonColumn, type NewRowOf, type RowOf, type RowUpdateOf } from './index.ts';

interface LocalizedText {
  en: string;
  de?: string;
}

declare module './types.ts' {
  interface JsonTypes {
    'json_events.options': readonly string[];
    'json_events.title': LocalizedText;
    'json_events.starts': Date;
    'json_events.parsed': { at: Date };
    'json_events.lazy': { note?: string };
    'json_events.handler': () => void;
    'json_events.tree': Tree;
    'json_events.open': Record<string, unknown>;
  }
  interface PrimaryKeys {
    json_events: 'id';
  }
}

interface Tree {
  label: string;
  children: Tree[];
}

interface JsonTables {
  json_events: {
    id: Generated<string>;
    options: JsonColumn<'json_events.options'> | null;
    title: JsonColumn<'json_events.title'>;
    free: JsonColumn<'json_events.free'>;
    plain: JsonColumn;
    starts: JsonColumn<'json_events.starts'>;
    parsed: JsonColumn<'json_events.parsed'>;
    lazy: JsonColumn<'json_events.lazy'>;
    handler: JsonColumn<'json_events.handler'>;
    tree: JsonColumn<'json_events.tree'>;
    open: JsonColumn<'json_events.open'>;
    json: JsonColumn<'json_events.json'>;
  };
}

class Events extends Repository<'json_events', JsonTables> {
  static table = 'json_events' as const;
}
declare const events: Events;
declare const db: Connection<JsonTables>;

type Read = RowOf<JsonTables['json_events']>;
const INVALID = "'json_events.starts' in JsonTypes is not JSON: a Date, class, function, bigint, unknown or undefined field cannot be stored";

export async function jsonTypes() {
  // A declared column reads as its type, through the row type, a select and a finder.
  expectTypeOf<Read['options']>().toEqualTypeOf<readonly string[] | null>();
  expectTypeOf<Read['title']>().toEqualTypeOf<LocalizedText>();
  const selected = await db.selectFrom('json_events').select(['options', 'title']).executeTakeFirstOrThrow();
  expectTypeOf(selected.options).toEqualTypeOf<readonly string[] | null>();
  expectTypeOf(selected.title).toEqualTypeOf<LocalizedText>();
  const found = await events.find('1');
  expectTypeOf(found!.title.en).toEqualTypeOf<string>();
  expectTypeOf(found!.options).toEqualTypeOf<readonly string[] | null>();

  // Without a declaration, or without a key, it stays Json.
  expectTypeOf<Read['free']>().toEqualTypeOf<Json>();
  expectTypeOf<Read['plain']>().toEqualTypeOf<Json>();
  expectTypeOf<RowOf<{ x: JsonColumn<string> }>['x']>().toEqualTypeOf<Json>();

  // Interfaces, optional fields, readonly arrays and recursive types are JSON.
  expectTypeOf<Read['lazy']>().toEqualTypeOf<{ note?: string }>();
  expectTypeOf<Read['tree']>().toEqualTypeOf<Tree>();

  // A declared type JSON cannot hold reads as a message, where the value is used.
  expectTypeOf<Read['starts']>().toEqualTypeOf<typeof INVALID>();
  // @ts-expect-error — the message is a string, not a Date
  void (found!.starts as Date).getTime();
  // `unknown` is no JSON either: an open part is typed `Json`.
  expectTypeOf<Read['open']>().toBeString();
  expectTypeOf<Read['parsed']>().toBeString();
  expectTypeOf<Read['handler']>().toBeString();

  // A write still takes the text, whatever the declared type is.
  const insert: NewRowOf<JsonTables['json_events']> = { starts: '', parsed: '', lazy: '', handler: '', tree: '', open: '', json: '', title: JSON.stringify({ en: 'x' }), free: '[]', plain: '{}' };
  const update: RowUpdateOf<JsonTables['json_events']> = { options: JSON.stringify(['a']) };
  // @ts-expect-error — the declared value is read, not written: the column takes JSON.stringify(value)
  const object: RowUpdateOf<JsonTables['json_events']> = { title: { en: 'x' } };
  // @ts-expect-error — nor an array: Postgres would store it as one of its own arrays
  const array: RowUpdateOf<JsonTables['json_events']> = { options: ['a'] };
  return [insert, update, object, array];
}
