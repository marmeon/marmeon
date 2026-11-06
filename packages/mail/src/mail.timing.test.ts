import { describe, expect, it } from 'vitest';
import { textFromHtml } from './html.ts';
import { loadedUrls } from './mjml.ts';

// Wall-clock tests run alone and last (the `timing` project). Each input is long enough that a quadratic scan needs
// seconds, many times the bound, while the linear one takes a few milliseconds.
const time = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('the time of deriving the text of a mail', () => {
  it('takes linear time for a long run of spaces or tabs', () => {
    for (const blank of [' ', '\t', ' \t']) {
      expect(time(() => textFromHtml(`<p>x${blank.repeat(100_000)}x</p>`)), JSON.stringify(blank)).toBeLessThan(100);
      expect(time(() => textFromHtml(`<p>x\n${blank.repeat(100_000)}x</p>`)), JSON.stringify(blank)).toBeLessThan(100);
    }
  });
});

describe('the time of removing the tags of a mail', () => {
  it('takes linear time for a long run of `<` that never closes', () => {
    for (const text of ['<', '< ', '<1']) {
      expect(time(() => textFromHtml(text.repeat(100_000))), text).toBeLessThan(1000);
      expect(time(() => textFromHtml(`<a href="x">${text.repeat(100_000)}</a>`)), text).toBeLessThan(1000);
    }
  });
});

describe('the time of dropping the comments, blocks and links of a mail', () => {
  // Each start repeated without its end: a regex with a lazy `[\s\S]*?` or a `[^>]*` retries the rest of the text at every one.
  // A trailing `>` only where it still leaves every start open (after `<!--` it makes `-->`, after `<li` it closes the first tag).
  // `<a href="` runs 1 000 times: a regex is cubic there, so more would hang the run instead of failing it.
  it('takes linear time for many starts without an end', () => {
    const cases: [start: string, times: number, ends: string[]][] = [
      ['<!--', 100_000, ['']],
      ['<style', 100_000, ['', '>']],
      ['<a ', 100_000, ['', '>']],
      ['<a href="', 1_000, ['', '>']],
      ['<div style="display:none"', 100_000, ['', '>']],
      ['<li', 100_000, ['']],
    ];
    for (const [start, times, ends] of cases) {
      for (const end of ends) expect(time(() => textFromHtml(`${start.repeat(times)}${end}`)), `${start}…${end}`).toBeLessThan(1000);
    }
  });
});

describe('the time of finding the URLs a mail loads', () => {
  it('takes linear time for many tag starts without an end', () => {
    // Escaped user text (`&lt;link`) is what an attacker controls; a literal `<` is the author's own markup.
    for (const text of ['&lt;link ', '&lt;image ', '&lt;mj-font ', '&#60;link ']) {
      expect(time(() => loadedUrls(text.repeat(100_000))), text).toBeLessThan(200);
    }
  });

  it('takes linear time for many attribute starts', () => {
    for (const text of ['src="', 'srcset=', 'url(', '@import "']) {
      expect(time(() => loadedUrls(text.repeat(100_000))), text).toBeLessThan(200);
    }
  });
});
