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
