import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('isResponse in a realm of its own: its Response is the root of its own chain, and the walk does not throw', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('./response.ts', import.meta.url), 'utf8')).replaceAll('export function', 'function');
  // A realm whose global `Response` comes from outside: its chain ends in a `Function.prototype` that is not the realm's own.
  const sandbox = { Response, result: undefined as unknown };
  runInNewContext(`${source}\nresult = { own: isResponse(new Response('x')), plain: isResponse({}) };`, sandbox);
  expect(sandbox.result).toEqual({ own: true, plain: false });
});
