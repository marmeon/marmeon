import { timingSafeEqual } from 'node:crypto';

/** Equal texts, compared in constant time for their length (a different length is a difference anyone can see). */
export function same(a: string, b: string): boolean {
  // A lone surrogate becomes U+FFFD in UTF-8, so it would equal a text that holds the real U+FFFD: a text that is not well formed is no match.
  if (!a.isWellFormed() || !b.isWellFormed()) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
