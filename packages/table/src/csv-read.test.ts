import { describe, expect, it } from 'vitest';
import { csvLine } from './csv.ts';
import { readCsv, type ReadCsvOptions } from './csv-read.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOM = [0xef, 0xbb, 0xbf];

function utf16(text: string, order: 'le' | 'be'): Uint8Array {
  const bytes: number[] = order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff];
  for (const unit of text) {
    const code = unit.charCodeAt(0);
    bytes.push(...(order === 'le' ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff]));
  }
  return Uint8Array.from(bytes);
}

function value(bytes: Uint8Array, options?: ReadCsvOptions) {
  const result = readCsv(bytes, options);
  if (!result.ok) throw new Error(`unexpected ${result.error.kind}`);
  return result.value;
}

function errorOf(bytes: Uint8Array, options?: ReadCsvOptions) {
  const result = readCsv(bytes, options);
  return result.ok ? 'ok' : result.error;
}

describe('readCsv(): fixtures', () => {
  it('reads UTF-8 with commas', () => {
    expect(value(utf8('name,city\nAda,Köln\nGrace,"Berlin"\n'))).toEqual({
      headers: ['name', 'city'],
      rows: [['Ada', 'Köln'], ['Grace', 'Berlin']],
      delimiter: ',',
      encoding: 'utf-8',
    });
  });

  it('reads a German spreadsheet export: semicolons, Windows-1252, umlauts', () => {
    // "Name;Straße\r\nMüller;Grüne Gasse\r\n" with ß = 0xDF and ü = 0xFC
    const bytes = Uint8Array.from([...utf8('Name;Stra'), 0xdf, ...utf8('e\r\nM'), 0xfc, ...utf8('ller;Gr'), 0xfc, ...utf8('ne Gasse\r\n')]);
    expect(value(bytes)).toEqual({
      headers: ['Name', 'Straße'],
      rows: [['Müller', 'Grüne Gasse']],
      delimiter: ';',
      encoding: 'windows-1252',
    });
  });

  it('reads Windows-1252 when asked, with the euro sign at 0x80', () => {
    expect(value(Uint8Array.from([...utf8('a;b\n1;'), 0x80, ...utf8('\n')]), { encoding: 'windows-1252' }).rows).toEqual([['1', '€']]);
  });

  it('takes UTF-8 with a byte order mark and drops exactly that mark', () => {
    const result = value(Uint8Array.from([...BOM, ...utf8('id;name\n1;Zoë\n')]));
    expect(result).toMatchObject({ encoding: 'utf-8', delimiter: ';', headers: ['id', 'name'], rows: [['1', 'Zoë']] });
  });

  it('reads UTF-16LE and UTF-16BE with a tab and a mark', () => {
    for (const order of ['le', 'be'] as const) {
      expect(value(utf16('id\tname\r\n1\tZoë\r\n', order))).toEqual({
        headers: ['id', 'name'],
        rows: [['1', 'Zoë']],
        delimiter: '\t',
        encoding: order === 'le' ? 'utf-16le' : 'utf-16be',
      });
    }
  });

  it('keeps quotes, delimiters, doubled quotes and line breaks inside a quoted cell', () => {
    const csv = 'a,b\r\n"line one\r\nline two","say ""hi"", ok"\r\n"x\ry",z\r\n';
    expect(value(utf8(csv)).rows).toEqual([['line one\r\nline two', 'say "hi", ok'], ['x\ry', 'z']]);
  });

  it('reads CRLF, LF and CR as line ends, and skips blank lines and the final one', () => {
    for (const end of ['\r\n', '\n', '\r']) {
      expect(value(utf8(`a,b${end}1,2${end}${end}3,4${end}`)).rows, JSON.stringify(end)).toEqual([['1', '2'], ['3', '4']]);
    }
    expect(value(utf8('a,b\n1,2')).rows).toEqual([['1', '2']]);
  });

  it('keeps empty cells in a row, and skips a row whose cells are all empty', () => {
    expect(value(utf8('a,b,c\n,x,\n,,\n""\n\n')).rows).toEqual([['', 'x', '']]);
    expect(value(utf8('a;b\n;\n1;2\n;\n')).rows).toEqual([['1', '2']]);
  });

  it('finds the delimiter in the header outside quotes, and lets the app name it', () => {
    expect(value(utf8('"a,b,c";d\n1;2\n')).delimiter).toBe(';');
    expect(value(utf8('a;b;c\n1;2;3\n'), { delimiter: ',' }).headers).toEqual(['a;b;c']);
    expect(value(utf8('single\nrow\n')).delimiter).toBe(',');
  });

  it('answers an empty file with no rows', () => {
    expect(value(new Uint8Array())).toMatchObject({ headers: [], rows: [] });
    expect(value(Uint8Array.from(BOM))).toMatchObject({ headers: [], rows: [] });
  });
});

describe('readCsv(): export to import', () => {
  const header = ['=1+1', '@SUM(A1)', '-2+3', '+1', 'plain, with "quotes"\nand a break', '-12.50', ''];
  const row = ['\t=x', 'ordinary', 'ünï', '', '-5', '\r=1', '"'];

  it('gives back the escaped cell, and with unescape the original', () => {
    const file = utf8(csvLine(header) + csvLine(row));
    expect(value(file).headers.slice(0, 4)).toEqual(["'=1+1", "'@SUM(A1)", "'-2+3", "'+1"]);
    const back = value(file, { unescape: true });
    expect(back.headers).toEqual(header);
    expect(back.rows).toEqual([row]);
  });

  it('gives back every text that starts with quotes before a formula character, or is plain', () => {
    const texts = ["''=x", "'''=x", "'x", '=x', "'=x", "'", 'x'];
    const file = utf8(csvLine(texts) + csvLine(texts));
    const back = value(file, { unescape: true });
    expect(back.headers).toEqual(texts);
    expect(back.rows).toEqual([texts]);
    expect(value(file).rows[0]).not.toEqual(texts);
  });
});

describe('readCsv(): the format', () => {
  it('finds the delimiter with the parser\'s quote rule: a quote opens only at the start of a cell', () => {
    const result = value(utf8('email;na"me;role\nx@y;"a,b,c,d,e";user\nq@r;n;user\n'));
    expect(result).toMatchObject({ delimiter: ';', headers: ['email', 'na"me', 'role'] });
    expect(result.rows).toEqual([['x@y', 'a,b,c,d,e', 'user'], ['q@r', 'n', 'user']]);
  });

  it('settles a tie by the width the early rows keep', () => {
    const german = value(utf8('Name, Vorname;Rolle\nMüller, Hans;admin\nSchmidt;user\n'));
    expect(german).toMatchObject({ delimiter: ';', headers: ['Name, Vorname', 'Rolle'] });
    expect(value(utf8('a,b;c\n1,2;3\n4,5\n')).delimiter).toBe(',');
  });

  it('skips a first line of only empty cells, quoted or not, when it looks for the delimiter', () => {
    expect(value(utf8('""\na;b\n1;2'))).toMatchObject({ delimiter: ';', headers: ['a', 'b'], rows: [['1', '2']] });
    expect(value(utf8(';;\n\na;b\n1;2'))).toMatchObject({ delimiter: ';', headers: ['a', 'b'] });
  });

  it('prefers a tab, then a semicolon, then a comma, when each keeps the width of every early row', () => {
    expect(value(utf8('a,b;c\n1,2;3')).delimiter).toBe(';');
    expect(value(utf8('a;b\tc\n1;2\t3')).delimiter).toBe('\t');
  });

  it('takes an equal row length as the rule for every row, and reports the first that differs', () => {
    expect(errorOf(utf8('email,role\na@b\nc@d,user\n'))).toMatchObject({ kind: 'row-length', expected: 2, actual: 1, line: 2 });
    expect(errorOf(utf8('email,role\n\nc@d,user,admin\n'))).toMatchObject({ kind: 'row-length', expected: 2, actual: 3, line: 3 });
    expect(errorOf(utf8('a,b\n"x\ny",1\nz\n'))).toMatchObject({ kind: 'row-length', line: 4 });
  });

  it('lets a byte order mark decide the encoding, and refuses one that contradicts the named encoding', () => {
    const marked = Uint8Array.from([...BOM, ...utf8('name;role\n')]);
    expect(value(marked).encoding).toBe('utf-8');
    expect(value(marked, { encoding: 'utf-8' }).headers).toEqual(['name', 'role']);
    expect(errorOf(marked, { encoding: 'windows-1252' })).toMatchObject({ kind: 'not-text' });
    expect(errorOf(utf16('a\n', 'le'), { encoding: 'utf-8' })).toMatchObject({ kind: 'not-text' });
  });
});

describe('readCsv(): limits', () => {
  it('refuses a file over maxBytes before decoding it', () => {
    expect(errorOf(utf8('a,b\n1,2\n'), { maxBytes: 7 })).toMatchObject({ kind: 'too-large', limit: 7 });
    expect(errorOf(utf8('a,b\n1,2\n'), { maxBytes: 8 })).toBe('ok');
    expect(errorOf(new Uint8Array(5 * 1024 * 1024 + 1))).toMatchObject({ kind: 'too-large' });
  });

  it('refuses too many rows, counting below the header', () => {
    expect(errorOf(utf8('a\n1\n2\n3\n'), { maxRows: 3 })).toBe('ok');
    expect(errorOf(utf8('a\n1\n2\n3\n4\n'), { maxRows: 3 })).toMatchObject({ kind: 'too-many-rows', limit: 3, line: 5 });
  });

  it('refuses too many columns, in the header and in a row', () => {
    expect(errorOf(utf8('a,b,c\n'), { maxColumns: 3 })).toBe('ok');
    expect(errorOf(utf8('a,b,c,d\n'), { maxColumns: 3 })).toMatchObject({ kind: 'too-many-columns', limit: 3, line: 1 });
    expect(errorOf(utf8('a,b\n1,2,3,4\n'), { maxColumns: 3 })).toMatchObject({ kind: 'too-many-columns', line: 2 });
    expect(errorOf(utf8(`a${','.repeat(1000)}`))).toMatchObject({ kind: 'too-many-columns', limit: 100 });
  });

  it('refuses a cell that is too long, quoted or not, before it grows', () => {
    expect(errorOf(utf8('a\nabc\n'), { maxCellLength: 3 })).toBe('ok');
    expect(errorOf(utf8('a\nabcd\n'), { maxCellLength: 3 })).toMatchObject({ kind: 'cell-too-long', limit: 3, line: 2 });
    expect(errorOf(utf8('a\n"ab\ncd"\n'), { maxCellLength: 3 })).toMatchObject({ kind: 'cell-too-long', line: 2 });
  });

  it('refuses a quote that is never closed, at the line it opened', () => {
    expect(errorOf(utf8('a,b\n1,"never\nclosed\n'))).toMatchObject({ kind: 'unclosed-quote', line: 2 });
    expect(errorOf(utf8('"'))).toMatchObject({ kind: 'unclosed-quote', line: 1 });
  });

  it('refuses what is no text: NUL bytes, odd UTF-16, invalid UTF-8 asked for', () => {
    expect(errorOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))).toMatchObject({ kind: 'not-text' });
    expect(errorOf(utf8('a,b\n1,\0\n'))).toMatchObject({ kind: 'not-text' });
    expect(errorOf(Uint8Array.from([0xff, 0xfe, 0x61]))).toMatchObject({ kind: 'not-text' });
    expect(errorOf(Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00]))).toMatchObject({ kind: 'not-text' });
    expect(errorOf(Uint8Array.from([0xff]), { encoding: 'utf-8' })).toMatchObject({ kind: 'not-text' });
  });

  it('rejects a limit that is no positive whole number', () => {
    expect(() => readCsv(utf8('a'), { maxRows: 0 })).toThrow(TypeError);
    expect(() => readCsv(utf8('a'), { maxBytes: 1.5 })).toThrow(TypeError);
  });
});

describe('readCsv(): random input', () => {
  it('ends on every byte soup with a result or an error, never an exception', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const alphabet = ['"', '"', ',', ';', '\t', '\r', '\n', 'a', '=', "'", '\0', 'ü'];
    for (let n = 0; n < 2000; n++) {
      const length = next() % 80;
      let text = '';
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length];
      const result = readCsv(utf8(text), { maxRows: 5, maxColumns: 5, maxCellLength: 20 });
      if (result.ok) expect(result.value.rows.every((row) => row.length <= 5)).toBe(true);
      else expect(['too-large', 'cell-too-long', 'row-length', 'too-many-rows', 'too-many-columns', 'unclosed-quote', 'not-text']).toContain(result.error.kind);
    }
  });
});
