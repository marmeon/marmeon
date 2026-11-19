/** The most bytes the key of an InnoDB index holds (the primary key and every other index alike). */
export const MYSQL_KEY_BYTES = 3072;

/** The most columns an index covers. */
export const MYSQL_KEY_PARTS = 16;

/** The bytes MySQL packs a number of decimal digits into: nine digits take four bytes, the rest as listed. */
const LEFTOVER_DIGITS = [0, 1, 1, 2, 2, 3, 3, 4, 4] as const;

const packed = (digits: number): number => Math.floor(digits / 9) * 4 + LEFTOVER_DIGITS[digits % 9]!;

/** The bytes of a `decimal(precision, scale)` in a key, or undefined for one MySQL does not allow. */
function decimalBytes(precision: number, scale: number): number | undefined {
  return scale <= precision && precision <= 65 && scale <= 30 ? packed(precision - scale) + packed(scale) : undefined;
}

/**
 * What a column of this type (as the blueprint writes it for MySQL) takes in an index key: its bytes, `'unindexable'` for a type MySQL
 * cannot put in a key without a prefix length (`longtext`, `longblob`, `json`), or undefined for a type this function does not know to the
 * byte. `perCharacter` is the most bytes a character of the column's character set takes: four in utf8mb4, which every table Marmeon creates is, and
 * fewer in a table whose default another migration changed. In utf8mb4 one `varchar(768)` fills the 3072 bytes alone; a
 * `varchar(767)` and an `integer` fill them too, and with a `bigint` instead the key is four bytes too wide.
 */
export function mysqlKeyBytes(type: string, perCharacter = 4): number | 'unindexable' | undefined {
  const text = /^(?:varchar|char)\((\d+)\)$/.exec(type);
  if (text) return Number(text[1]) * perCharacter;
  const decimal = /^numeric\((\d+), ?(\d+)\)$/.exec(type);
  if (decimal) return decimalBytes(Number(decimal[1]), Number(decimal[2]));
  switch (type) {
    case 'bigint':
    case 'double':
      return 8;
    case 'integer':
      return 4;
    case 'date':
      return 3;
    case 'datetime(3)':
      return 7;
    case 'boolean':
      return 1;
    case 'longtext':
    case 'longblob':
    case 'json':
      return 'unindexable';
    default:
      return undefined;
  }
}

/** A column as `information_schema.columns` reports it. */
export interface CatalogColumn {
  readonly dataType: string;
  readonly columnType: string;
  /** `character_octet_length`: the bytes a value of a character or binary column takes at most; null for the other types. */
  readonly octets: number | null;
}

const FRACTION_BYTES = [0, 1, 1, 2, 2, 3, 3] as const;

/**
 * What a column the database has takes in an index key, from the catalog: like {@link mysqlKeyBytes}, but for the types and character sets
 * of a column that raw SQL may have changed. A character or binary column counts its `octets` (a latin1 column one byte a character, a
 * utf8mb4 one four); `'unindexable'` is a text, blob or JSON column; undefined is a type this function does not know to the byte.
 */
export function mysqlCatalogKeyBytes(column: CatalogColumn): number | 'unindexable' | undefined {
  switch (column.dataType) {
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return column.octets ?? undefined;
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'json':
      return 'unindexable';
    case 'tinyint':
      return 1;
    case 'smallint':
      return 2;
    case 'mediumint':
      return 3;
    case 'int':
    case 'float':
      return 4;
    case 'bigint':
    case 'double':
      return 8;
    case 'date':
      return 3;
    case 'datetime': {
      const fraction = /^datetime(?:\(([0-6])\))?$/.exec(column.columnType);
      return fraction ? 5 + FRACTION_BYTES[Number(fraction[1] ?? 0)]! : undefined;
    }
    case 'decimal': {
      const decimal = /^decimal\((\d+),(\d+)\)(?: unsigned)?$/.exec(column.columnType);
      return decimal ? decimalBytes(Number(decimal[1]), Number(decimal[2])) : undefined;
    }
    default:
      return undefined;
  }
}
