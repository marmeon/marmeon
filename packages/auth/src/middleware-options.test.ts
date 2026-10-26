import { describe, expect, it } from 'vitest';
import { confirmedPassword } from './middleware.ts';

describe('confirmedPassword() options', () => {
  it('refuses the old `seconds` for an untyped caller instead of using the default window', () => {
    // @ts-expect-error — the window is `maxAge`, a Duration
    expect(() => confirmedPassword({ seconds: 5 })).toThrow('`seconds` was renamed `maxAge`');
  });

  it('takes a Duration', () => {
    expect(() => confirmedPassword({ maxAge: { minutes: 5 } })).not.toThrow();
    expect(() => confirmedPassword({ maxAge: 300 })).not.toThrow();
  });

  it('takes only a window above zero', () => {
    for (const maxAge of [0, -1, { minutes: 0 }]) expect(() => confirmedPassword({ maxAge }), String(maxAge)).toThrow('Duration above zero');
    expect(() => confirmedPassword({ maxAge: Number.NaN })).toThrow(TypeError);
  });
});
