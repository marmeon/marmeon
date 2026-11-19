import { describe, expect, it } from 'vitest';
import { leadingReadings, leadingWords } from './metadata.ts';
import { versionOf } from './mysql-session.ts';

const SERVER = 80413;
const words = (sql: string, version: number | 'code' | 'comment' = SERVER) => leadingWords(sql, 3, version).words;

describe('leadingWords()', () => {
  it('skips whitespace and comments in front of the first words, and stops at what is not a word', () => {
    expect(words('  /* a */ -- b\n# c\n Start   Transaction read only')).toEqual(['start', 'transaction', 'read']);
    expect(words('--x begin')).toEqual([]);
    expect(words('(select 1)')).toEqual([]);
    expect(words('1begin')).toEqual([]);
    expect(words('commit_log work')).toEqual(['commit_log', 'work']);
  });

  it('reads a version comment as the server does: of an older or the same version it runs, of a newer one it is skipped (measured on 8.4.13)', () => {
    expect(words('/*!80000 begin */')).toEqual(['begin']);
    expect(words('/*!80413 begin */')).toEqual(['begin']);
    expect(words('/*!80414 begin */ select 1')).toEqual(['select']);
    expect(words('/*!99999 commit */ select 1')).toEqual(['select']);
    // Five digits, whatever follows them.
    expect(words('/*!80000begin */')).toEqual(['begin']);
    expect(words('/*!99999begin */ select 1')).toEqual(['select']);
    // Six digits and whitespace are the version; six digits and a letter are five digits and a digit of the code.
    expect(words('/*!080000 begin */')).toEqual(['begin']);
    expect(words('/*!800000 begin */ select 1')).toEqual(['select']);
    expect(words('/*!800000begin */')).toEqual([]);
    // Seven digits: five are the version, the rest is code. Fewer than five run always, and are code.
    expect(words('/*!8000000 begin */')).toEqual([]);
    expect(words('/*!8040 begin */')).toEqual([]);
    expect(words('/*! begin */')).toEqual(['begin']);
    // A comment of MariaDB is a comment to MySQL.
    expect(words('/*M!100000 begin */ select 1')).toEqual(['select']);
    expect(words('/*!99999 x */ /*!80000 begin */')).toEqual(['begin']);
  });

  it('lets a skipped version comment hold a comment of its own, as the server does: its `*/` does not end the outer one', () => {
    for (const sql of [
      '/*!99999 /* a */ x */ begin',
      '/*!99999 /* a */ /* b */ x */ begin',
      '/*!99999 /**/ x */ begin',
      '/*!99999 /*+ a */ x */ begin',
      '/*!99999 /*! b */ x */ begin',
      '/*!99999 /*!80000 b */ x */ begin',
    ]) {
      expect(words(sql), sql).toEqual(['begin']);
    }
    // What stands behind the nested comment is still inside the skipped one.
    expect(words('/*!99999 x /* y */ begin */ do 0')).toEqual(['do']);
    // One that runs reads a comment inside it as a comment.
    expect(words('/*!80000 /* a */ begin */')).toEqual(['begin']);
  });

  it('says that a version comment that runs came first, and not one that is skipped', () => {
    expect(leadingWords('/*!80000 select 1 */', 1, SERVER).executable).toBe(true);
    expect(leadingWords('/*!99999 select 1 */ select 2', 1, SERVER).executable).toBe(false);
    expect(leadingWords('/*+ hint */ select 2', 1, SERVER).executable).toBe(true);
  });
});

describe('leadingReadings()', () => {
  it('gives every reading when the server is not known: a keyword in any version comment, and the one behind them', () => {
    expect(leadingReadings('/*!99999 commit */ select 1', 3).map((reading) => reading[0])).toEqual(expect.arrayContaining(['commit', 'select']));
    expect(leadingReadings('select 1', 3)).toEqual([['select']]);
  });
});

describe('versionOf()', () => {
  it('numbers a server as a version comment does', () => {
    expect(versionOf('8.4.13')).toBe(80413);
    expect(versionOf('9.1.0-debug')).toBe(90100);
    expect(versionOf('nonsense')).toBeUndefined();
    expect(versionOf(undefined)).toBeUndefined();
  });
});
