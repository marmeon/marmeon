import { describe, expect, it } from 'vitest';
import { Redactor, redactText } from './redact.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. Each input is long enough
// that a pattern which backtracks quadratically (n² steps, at least a few ns each) needs seconds to minutes — more than 20 times
// the bound — while the linear scan takes a few milliseconds.
describe('the time of masking hostile input', () => {
  it('takes linear time for a long text without an @', () => {
    // 100 000 / 96 000 / 100 000 characters: n² is 10¹⁰ steps, seconds against the bound of 50 ms.
    for (const text of [`postgres://u:${'x'.repeat(100_000)}`, 'a://b:'.repeat(16_000), `http://h:80/${'/a:b'.repeat(25_000)}`]) {
      const started = performance.now();
      redactText(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it('runs in linear time on hostile input', () => {
    // 100 000 to 200 000 characters: n² is at least 10¹⁰ steps, seconds against the bound of 200 ms.
    for (const input of ['a-'.repeat(50_000), `eyJ${'a'.repeat(100_000)}`, `eyJ${'a.'.repeat(50_000)}`, 'ghp_'.repeat(25_000), 'eyJ'.repeat(30_000), `${'a'.repeat(100_000)}!`, `${'Ab1-'.repeat(25_000)}`]) {
      const start = performance.now();
      redactText(input);
      expect(performance.now() - start, input.slice(0, 20)).toBeLessThan(200);
    }
  });

  it('masks in time that does not grow with the square of the input — a long word, a long header', () => {
    // 150 000 to 200 000 characters: n² is at least 2·10¹⁰ steps, seconds against the bound of 100 ms.
    const inputs = [
      `${'a'.repeat(200_000)}:/x://y`,
      `${'my_password'.repeat(18_000)}`,
      `${'pass'.repeat(50_000)}=x`,
      `${'otp'.repeat(60_000)}`,
      `${'recovery'.repeat(25_000)} x`,
      `${'-----BEGIN PRIVATE KEY-----'.repeat(7_000)}`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      new Redactor().text(input);
      new Redactor().log({ agent: input });
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
