import type { CommandInput } from '@bespokecore/cli';
import { Translator } from '../../index.ts';

/** Needs the scoped Translator — resolvable because a command runs in a scope of its own (in APP_LOCALE). */
export class GreetCommand {
  static readonly command = 'fixture:greet';
  static readonly description = 'Greets in APP_LOCALE';

  readonly #translator: Translator;

  constructor(translator: Translator) {
    this.#translator = translator;
  }

  handle({ output }: CommandInput): number {
    output.line(`${this.#translator.locale}: ${this.#translator.text('bespoke.errors.throttled', {}, 'Too many attempts.')}`);
    return this.#translator.locale === 'de' ? 0 : 3;
  }
}
