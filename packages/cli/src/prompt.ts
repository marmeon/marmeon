import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { isatty } from 'node:tty';

/** A question a command may put to the person at the terminal. Given to a command and not meant to be implemented — tests use `app.command()`. See docs/console.md#asking-a-question. */
export interface Prompt {
  /** Whether a question reaches a person: a terminal on both ends, no `CI` and no `--no-interaction`. */
  readonly interactive: boolean;
  /**
   * Asks for one choice, or with `multiple` for several, and resolves with the indexes of `choices` picked (none: `[]`).
   * Control characters in `question` and `choices` are dropped. Check `interactive` first: this throws when it is false, so
   * a command asks only where it may. Ctrl-C or the end of input rejects with an error whose `code` is `ABORT_ERR`; the CLI
   * answers it with "cancelled" and exit code 130.
   */
  choose(question: string, choices: readonly string[], options?: { readonly multiple?: boolean }): Promise<readonly number[]>;
}

export interface PromptOptions {
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `--no-interaction` was given. */
  readonly noInteraction?: boolean;
}

/** Wrong answers one question accepts before it counts as "none". */
const ATTEMPTS = 3;

/** Set in the environment of a `spawn`ed command when `--no-interaction` was given, so the child asks nothing either. */
export const NO_INTERACTION_ENV = 'MARMEON_NO_INTERACTION';

/** A variable that is set to something other than empty, `0` or `false`. */
const flagSet = (value: string | undefined) => value !== undefined && value !== '' && value !== '0' && value !== 'false';

/** `CI` is set to something other than empty, `0` or `false`. */
export function ciSet(env: Readonly<Record<string, string | undefined>>): boolean {
  return flagSet(env.CI);
}

/** Marks the error of a cancelled question; `code` alone is not enough, Node gives `ABORT_ERR` to timeouts and aborted signals too. */
const CANCELLED = Symbol.for('marmeon.prompt.cancelled');

/** Whether `error` is Ctrl-C or the end of input at a question of `prompt.choose()`. */
export function isPromptCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[CANCELLED] === true;
}

/** Control characters (escape sequences, line breaks) in text a package or the app supplied would redraw or fake the question. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

function abortError(): Error {
  return Object.assign(new Error('The prompt was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR', [CANCELLED]: true });
}

export function createPrompt(options: PromptOptions = {}): Prompt {
  const env = options.env ?? process.env;
  const noInteraction = options.noInteraction === true || flagSet(env[NO_INTERACTION_ENV]);
  // Streams are injected by tests; otherwise the process's own, asked by file descriptor so `process.stdin` stays untouched until a question.
  const terminal = options.input || options.output ? options.input?.isTTY === true && options.output?.isTTY === true : isatty(0) && isatty(1);
  const interactive = terminal && !ciSet(env) && !noInteraction;

  return {
    interactive,
    async choose(question, choices, { multiple = false } = {}) {
      if (!interactive) {
        throw new Error('Cannot ask a question: there is no terminal, CI is set or --no-interaction was given. Check prompt.interactive first and take the answer from an option.');
      }
      if (choices.length === 0) return [];
      const input = options.input ?? process.stdin;
      const output = options.output ?? process.stdout;
      const lines = [plain(question), ...choices.map((choice, index) => `  ${index + 1}) ${plain(choice)}`)];
      const hint = multiple ? 'Numbers separated by commas, "a" for all, empty for none' : 'A number, empty for none';
      const readline = createInterface({ input, output });
      // Ctrl-C and the end of input close the interface; a pending question then never settles by itself.
      const closed = new Promise<never>((_, reject) => readline.once('close', () => reject(abortError())));
      closed.catch(() => {});
      try {
        output.write(`${lines.join('\n')}\n`);
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const answer = await Promise.race([readline.question(`${hint}: `), closed]);
          const picked = parseAnswer(answer, choices.length, multiple);
          if (picked) return picked;
          output.write(`Not a choice of 1 to ${choices.length}.\n`);
        }
        return [];
      } finally {
        readline.close();
      }
    },
  };
}

/** Indexes the answer names, or undefined when it is not an answer to this question. */
function parseAnswer(answer: string, count: number, multiple: boolean): readonly number[] | undefined {
  const text = answer.trim().toLowerCase();
  if (text === '') return [];
  if (text === 'a' && multiple) return Array.from({ length: count }, (_, index) => index);
  const words = text.split(/[,\s]+/).filter(Boolean);
  if (!words.every((word) => /^\d+$/.test(word))) return undefined;
  const indexes = [...new Set(words.map((word) => Number(word) - 1))];
  if (indexes.some((index) => index < 0 || index >= count)) return undefined;
  if (!multiple && indexes.length > 1) return undefined;
  return indexes.sort((a, b) => a - b);
}

/** What a command sees where nothing can be asked: scheduled runs and tests. */
export const noPrompt: Prompt = createPrompt({ noInteraction: true });
