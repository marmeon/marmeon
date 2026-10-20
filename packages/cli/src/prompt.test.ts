import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompt, isPromptCancelled, noPrompt, type PromptOptions } from './prompt.ts';

/** A terminal that answers each question in turn; once the answers are used up, the input ends. */
function terminal(answers: readonly string[], options: Pick<PromptOptions, 'env' | 'noInteraction'> = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const queue = [...answers];
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
    // The line asking for the answer ends in ": "; answer when it arrives.
    if (!written.endsWith(': ')) return;
    written += '\n';
    const next = queue.shift();
    // '\x03' is Ctrl-C, typed without Enter.
    setImmediate(() => (next === undefined ? input.end() : input.write(next === '\x03' ? next : `${next}\n`)));
  });
  return { prompt: createPrompt({ input, output, env: {}, ...options }), text: () => written };
}

describe('prompt.choose on a terminal', () => {
  const choices = ['one', 'two', 'three'];

  it('is interactive', () => {
    expect(terminal([]).prompt.interactive).toBe(true);
  });

  it('numbers the choices from 1 and returns the index of the answer', async () => {
    const { prompt, text } = terminal(['2']);
    expect(await prompt.choose('Which?', choices)).toEqual([1]);
    expect(text()).toContain('Which?');
    expect(text()).toContain('1) one');
    expect(text()).toContain('3) three');
  });

  it('takes several numbers separated by commas or spaces with multiple', async () => {
    expect(await terminal(['1, 3']).prompt.choose('Which?', choices, { multiple: true })).toEqual([0, 2]);
    expect(await terminal(['3 1']).prompt.choose('Which?', choices, { multiple: true })).toEqual([0, 2]);
  });

  it('takes "a" as all with multiple only', async () => {
    expect(await terminal(['a']).prompt.choose('Which?', choices, { multiple: true })).toEqual([0, 1, 2]);
    expect(await terminal(['a', '2']).prompt.choose('Which?', choices)).toEqual([1]);
  });

  it('refuses several numbers for a single choice', async () => {
    expect(await terminal(['1,2', '3']).prompt.choose('Which?', choices)).toEqual([2]);
  });

  it('treats an empty answer as none', async () => {
    expect(await terminal(['']).prompt.choose('Which?', choices)).toEqual([]);
    expect(await terminal(['  ']).prompt.choose('Which?', choices, { multiple: true })).toEqual([]);
  });

  it('asks again after an answer that is no choice', async () => {
    const { prompt, text } = terminal(['9', 'x', '0', '2']);
    expect(await prompt.choose('Which?', choices)).toEqual([]);
    expect(text().match(/Not a choice/g)).toHaveLength(3);
    expect(await terminal(['9', '2']).prompt.choose('Which?', choices)).toEqual([1]);
  });

  it('rejects with a marked abort error at the end of input and at Ctrl-C', async () => {
    for (const answers of [[], ['\x03']]) {
      const error = await terminal(answers).prompt.choose('Which?', choices).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
      expect(isPromptCancelled(error)).toBe(true);
    }
  });

  it('marks only its own cancellation: other abort errors, and things that are no errors, are not one', () => {
    expect(isPromptCancelled(Object.assign(new Error('timed out'), { name: 'AbortError', code: 'ABORT_ERR' }))).toBe(false);
    for (const thrown of [null, undefined, 'x', 0]) expect(isPromptCancelled(thrown)).toBe(false);
  });

  it('asks nothing of an empty list', async () => {
    expect(await terminal([]).prompt.choose('Which?', [])).toEqual([]);
  });

  it('drops control characters from the question and the choices', async () => {
    const { prompt, text } = terminal(['1']);
    await prompt.choose('Which?\u001b[2J', ['evil\u001b[31m\r\nfake) 9', 'a\u0007b‮']);
    expect(text()).toContain('1) evil[31mfake) 9');
    expect(text()).toContain('2) ab');
    expect(text().split('2) ab')[0]?.replaceAll('\n', '')).not.toMatch(/\p{Cc}|\p{Cf}/u);
  });
});

describe('prompt.interactive', () => {
  const tty = () => Object.assign(new PassThrough(), { isTTY: true });
  const pipe = () => new PassThrough();

  it('is false without a terminal, and choose() does not ask but says what to do', async () => {
    const streams: [PassThrough, PassThrough][] = [
      [pipe(), pipe()],
      [tty(), pipe()],
      [pipe(), tty()],
    ];
    for (const [input, output] of streams) {
      const prompt = createPrompt({ input, output, env: {} });
      expect(prompt.interactive).toBe(false);
      await expect(prompt.choose('Which?', ['a'])).rejects.toThrow(/Check prompt\.interactive/);
      expect(output.read()).toBeNull();
    }
  });

  it('is false in CI', async () => {
    const { prompt } = terminal([], { env: { CI: '1' } });
    expect(prompt.interactive).toBe(false);
    await expect(prompt.choose('Which?', ['a'])).rejects.toThrow(/no terminal, CI is set/);
    expect(terminal([], { env: { CI: 'true' } }).prompt.interactive).toBe(false);
  });

  it('stays true when CI is empty, 0 or false', () => {
    for (const CI of ['', '0', 'false']) expect(terminal([], { env: { CI } }).prompt.interactive).toBe(true);
  });

  it('is false with --no-interaction', async () => {
    const { prompt, text } = terminal([], { noInteraction: true });
    expect(prompt.interactive).toBe(false);
    await expect(prompt.choose('Which?', ['a'])).rejects.toThrow(/--no-interaction/);
    expect(text()).toBe('');
  });

  it('is false with MARMEON_NO_INTERACTION, which a spawned command inherits', async () => {
    const { prompt } = terminal([], { env: { MARMEON_NO_INTERACTION: '1' } });
    expect(prompt.interactive).toBe(false);
    await expect(prompt.choose('Which?', ['a'])).rejects.toThrow(/--no-interaction/);
    expect(terminal([], { env: { MARMEON_NO_INTERACTION: '0' } }).prompt.interactive).toBe(true);
  });

  it('is false for noPrompt', async () => {
    expect(noPrompt.interactive).toBe(false);
    await expect(noPrompt.choose('Which?', ['a'])).rejects.toThrow();
  });
});
