import { MARK_END, MARK_START } from '../terms.ts';

const NUL = String.fromCharCode(0);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const LONE_SURROGATE = String.fromCharCode(0xd800);

/** Search terms that carry the syntax of tsquery, FTS5 or a Meilisearch filter, or that are hard to cut: what each, and the term. */
export const HOSTILE: readonly (readonly [string, string])[] = [
  ['an unterminated FTS5 string and a group', 'foo" OR (bar'],
  ['an FTS5 column filter', 'a:see'],
  ['an FTS5 NEAR group', 'NEAR(x y)'],
  ['a lone star', '*'],
  ['every tsquery operator', "'):*&!<->\\"],
  ['only double quotes', '"""'],
  ['a NUL character', `ab${NUL}cd`],
  ['a forged highlight marker', `ab${MARK_START}cd${MARK_END}`],
  ['only stop words', 'the and of'],
  ['10 000 characters', 'x'.repeat(10_000)],
  ['40 words', Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')],
  ['emoji', '🔍 search 👩‍💻 code'],
  ['combining marks', `cafe${COMBINING_ACUTE} nai${String.fromCharCode(0x0308)}ve`],
  ['Arabic', 'مرحبا بالعالم'],
  ['Chinese', '全文搜索 测试'],
  ['FTS5 keywords and a caret', 'AND OR NOT ^start +more'],
  ['a tsquery weight and phrase', 'foo:AB <2> bar'],
  ['fullwidth operators that NFKC turns into syntax', '＂ａ＂ ＆ ｂ＊ ｜ （ｃ）'],
  ['a lone surrogate', `ab${LONE_SURROGATE}cd`],
];
