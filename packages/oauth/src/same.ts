import { timingSafeEqual } from 'node:crypto';

/** Equal texts, compared in constant time for their length (a different length is a difference anyone can see). */
export function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
