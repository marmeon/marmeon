import { describe, expect, it } from 'vitest';
import { conflict, isConflictResult } from './conflict.ts';
import { isJsonResult, json } from './json.ts';

describe('conflict()', () => {
  it('is a conflict result, never a JSON result — nothing can add headers (a location) to it', () => {
    const result = conflict({ version: 3 });
    expect(isConflictResult(result)).toBe(true);
    expect(isJsonResult(result)).toBe(false);
    expect(isConflictResult(json({ version: 3 }))).toBe(false);
    expect(result).toMatchObject({ kind: 'conflict', current: { version: 3 } });
    expect('headers' in result).toBe(false);
    expect('message' in result).toBe(false);
  });

  it('keeps the message it was given', () => {
    expect(conflict(1, { message: 'notes.stale' }).message).toBe('notes.stale');
  });

  it('refuses options it does not know, with the way out — a string, null, a list, an unknown key, a message that is no text', () => {
    expect(() => conflict(1, 'notes.stale' as never)).toThrow(/second argument is an object/);
    expect(() => conflict(1, null as never)).toThrow(/second argument is an object/);
    expect(() => conflict(1, [] as never)).toThrow(/second argument is an object/);
    expect(() => conflict(1, { status: 200 } as never)).toThrow("conflict(): unknown option 'status' — the only option is { message }");
    expect(() => conflict(1, { headers: { 'x-marmeon-location': '/' } } as never)).toThrow(/unknown option 'headers'/);
    expect(() => conflict(1, { message: 3 } as never)).toThrow(/message is a text or a key/);
  });
});
