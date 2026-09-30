import { Formatter } from './formatter.js';

export default class Greeting {
  readonly #formatter: Formatter;
  constructor(formatter: Formatter) {
    this.#formatter = formatter;
  }
  hello(name: string) {
    return this.#formatter.format(name, 'noon');
  }
}
